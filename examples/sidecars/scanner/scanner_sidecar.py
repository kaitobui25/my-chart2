"""Trading scanner sidecar for the L2Chart workstation."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

from aiohttp import web

from cafef_eod import (
    ACTIVE_MAX_AGE_DAYS,
    HISTORY_RETAIN_BARS,
    PROVIDER_ID as EOD_PROVIDER_ID,
    _import_latest as import_latest_eod,
)
from db import ScannerDB
from engine import ScanExecution, ScannerEngine
from local_eod_provider import LocalEodProvider
from models import ScanRequest
from providers import build_providers

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_DB_PATH = BASE_DIR / 'data' / 'scanner.db'
DEFAULT_FIINQUANT_ENV = BASE_DIR.parent / 'fiinquant' / '.env'
LOOPBACK_ORIGIN_HOSTS = {'127.0.0.1', '::1', 'localhost'}


class CafeFEodUpdateBusy(RuntimeError):
    pass


def read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding='utf-8').splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, _, value = line.partition('=')
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        values[key.strip()] = value
    return values


def allowed_origins() -> set[str]:
    raw = os.environ.get('SCANNER_ALLOWED_ORIGINS', '').strip()
    return {value.strip().rstrip('/') for value in raw.split(',') if value.strip()}


def is_allowed_origin(origin: str | None) -> bool:
    if not origin:
        return True
    normalized = origin.rstrip('/')
    try:
        parsed = urlsplit(normalized)
        loopback = parsed.scheme in {'http', 'https'} and parsed.hostname in LOOPBACK_ORIGIN_HOSTS
    except ValueError:
        loopback = False
    return loopback or normalized in allowed_origins()


@web.middleware
async def cors_middleware(request: web.Request, handler):
    origin = request.headers.get('Origin')
    if not is_allowed_origin(origin):
        return web.json_response({'message': 'origin not allowed'}, status=403)
    if request.method == 'OPTIONS':
        response = web.Response()
    else:
        response = await handler(request)
    if origin:
        response.headers['Access-Control-Allow-Origin'] = origin
        response.headers['Vary'] = 'Origin'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    return response


class ScannerRuntime:
    def __init__(self, db: ScannerDB, engine: ScannerEngine) -> None:
        self.db = db
        self.engine = engine
        self.jobs: dict[int, ScanExecution] = {}
        self.tasks: dict[int, asyncio.Task] = {}
        self.eod_update_lock = asyncio.Lock()
        self.eod_last_error: str | None = None

    async def start_scan(self, request: ScanRequest) -> int:
        run_id = await asyncio.to_thread(self.db.begin_scan, request.source, request.to_json())
        self.jobs[run_id] = ScanExecution(run_id=run_id)

        async def progress(next_state: ScanExecution) -> None:
            self.jobs[run_id] = next_state

        async def run() -> None:
            try:
                self.jobs[run_id] = await self.engine.execute(run_id, request, progress)
            finally:
                self.tasks.pop(run_id, None)
                self._prune_jobs()

        self.tasks[run_id] = asyncio.create_task(run(), name=f'scanner-run-{run_id}')
        return run_id

    async def eod_status(self) -> dict[str, object]:
        latest, coverage = await asyncio.gather(
            asyncio.to_thread(self.db.latest_successful_import, EOD_PROVIDER_ID),
            asyncio.to_thread(self.db.snapshot_coverage, EOD_PROVIDER_ID),
        )
        latest_trade_date = None if latest is None else latest.get('trade_date')
        return {
            'provider': EOD_PROVIDER_ID,
            'updating': self.eod_update_lock.locked(),
            'latestTradeDate': latest_trade_date,
            'activeSymbols': int(coverage.get('active_count') or 0),
            'snapshotSymbols': int(coverage.get('snapshot_count') or 0),
            'retentionBars': HISTORY_RETAIN_BARS,
            'activeMaxAgeDays': ACTIVE_MAX_AGE_DAYS,
            'latestImport': latest,
            'lastError': self.eod_last_error,
        }

    async def update_eod(self) -> dict[str, object]:
        if self.eod_update_lock.locked():
            raise CafeFEodUpdateBusy('CafeF EOD update is already running')
        async with self.eod_update_lock:
            self.eod_last_error = None
            try:
                return await asyncio.to_thread(import_latest_eod, self.db, 'eod')
            except Exception as exc:  # noqa: BLE001
                self.eod_last_error = str(exc)[:300]
                raise

    def _prune_jobs(self, keep: int = 40) -> None:
        completed = [run_id for run_id, job in self.jobs.items() if job.status != 'running']
        for run_id in sorted(completed)[:-keep]:
            self.jobs.pop(run_id, None)

    async def close(self) -> None:
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        for provider in self.engine.providers.values():
            await provider.close()
        await asyncio.to_thread(self.db.close)


def build_runtime() -> ScannerRuntime:
    fiinquant_env_path = Path(os.environ.get('FIINQUANT_ENV_PATH', str(DEFAULT_FIINQUANT_ENV)))
    fiinquant_env = read_env_file(fiinquant_env_path)
    username = os.environ.get('FIINQUANT_USERNAME', fiinquant_env.get('FIINQUANT_USERNAME', ''))
    password = os.environ.get('FIINQUANT_PASSWORD', fiinquant_env.get('FIINQUANT_PASSWORD', ''))
    db_path = Path(os.environ.get('SCANNER_DB_PATH', str(DEFAULT_DB_PATH)))
    db = ScannerDB(db_path, BASE_DIR / 'migrations')
    providers = build_providers(username, password)
    providers['vn_eod'] = LocalEodProvider()
    return ScannerRuntime(db, ScannerEngine(db, providers))


def build_app(runtime: ScannerRuntime | None = None) -> web.Application:
    runtime = runtime or build_runtime()
    app = web.Application(middlewares=[cors_middleware])
    app['runtime'] = runtime

    async def health(_request: web.Request) -> web.Response:
        return web.json_response({
            'ok': True,
            'database': str(runtime.db.path),
            'sources': [provider.capabilities.to_json() for provider in runtime.engine.providers.values()],
            'runningScans': len(runtime.tasks),
            'eodUpdating': runtime.eod_update_lock.locked(),
        })

    async def sources(_request: web.Request) -> web.Response:
        return web.json_response({
            'sources': [provider.capabilities.to_json() for provider in runtime.engine.providers.values()]
        })

    async def eod_status(_request: web.Request) -> web.Response:
        return web.json_response(await runtime.eod_status())

    async def eod_import_latest(_request: web.Request) -> web.Response:
        try:
            result = await runtime.update_eod()
        except CafeFEodUpdateBusy as exc:
            return web.json_response({'message': str(exc)}, status=409)
        except Exception as exc:  # noqa: BLE001
            return web.json_response({'message': f'CafeF EOD update failed: {str(exc)[:300]}'}, status=502)
        return web.json_response({
            'ok': True,
            'result': result,
            'status': await runtime.eod_status(),
        })

    async def scan(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
            parsed = ScanRequest.from_json(payload)
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            return web.json_response({'message': str(exc)}, status=400)
        provider = runtime.engine.providers.get(parsed.source)
        if provider is None:
            return web.json_response({'message': f'provider not configured: {parsed.source}'}, status=400)
        if not provider.capabilities.available:
            return web.json_response({'message': provider.capabilities.detail or 'provider unavailable'}, status=503)
        run_id = await runtime.start_scan(parsed)
        return web.json_response({'runId': run_id, 'status': 'running'}, status=202)

    async def run_status(request: web.Request) -> web.Response:
        try:
            run_id = int(request.match_info['run_id'])
        except ValueError:
            return web.json_response({'message': 'invalid run id'}, status=400)
        audit = await asyncio.to_thread(runtime.db.get_scan, run_id)
        if audit is None:
            return web.json_response({'message': 'scan run not found'}, status=404)
        job = runtime.jobs.get(run_id)
        payload = {
            **audit,
            'runId': run_id,
            'warnings': list(job.warnings) if job else [],
            'results': list(job.results) if job and job.status == 'complete' else [],
        }
        if job and job.error:
            payload['error'] = job.error
        return web.json_response(payload)

    async def backup(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        raw_path = str(payload.get('path') or '').strip()
        destination = Path(raw_path) if raw_path else runtime.db.path.with_name('scanner-backup.db')
        try:
            await asyncio.to_thread(runtime.db.backup, destination)
        except Exception as exc:  # noqa: BLE001
            return web.json_response({'message': str(exc)[:300]}, status=500)
        return web.json_response({'ok': True, 'path': str(destination)})

    async def on_cleanup(_app: web.Application) -> None:
        await runtime.close()

    app.on_cleanup.append(on_cleanup)
    app.router.add_get('/health', health)
    app.router.add_get('/sources', sources)
    app.router.add_get('/eod/status', eod_status)
    app.router.add_post('/eod/import-latest', eod_import_latest)
    app.router.add_post('/scan', scan)
    app.router.add_get('/runs/{run_id}', run_status)
    app.router.add_post('/backup', backup)
    return app


def main() -> None:
    host = os.environ.get('SCANNER_HOST', '127.0.0.1')
    port = int(os.environ.get('SCANNER_PORT', '8730'))
    runtime = build_runtime()
    print(f'Scanner sidecar listening on http://{host}:{port}')
    web.run_app(build_app(runtime), host=host, port=port, print=None)


if __name__ == '__main__':
    main()

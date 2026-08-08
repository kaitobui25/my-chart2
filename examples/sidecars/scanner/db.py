from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Iterable

from models import Candle, HeikinScan, Instrument, MarketSnapshot, ScanFilters

SCHEMA_VERSION = 2


class ScannerDB:
    def __init__(self, path: Path, migrations_dir: Path) -> None:
        self.path = path
        self.migrations_dir = migrations_dir
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.execute('PRAGMA journal_mode=WAL')
            self._conn.execute('PRAGMA synchronous=NORMAL')
            self._conn.execute('PRAGMA foreign_keys=ON')
            self._conn.execute('PRAGMA busy_timeout=5000')
            self._migrate()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def _migrate(self) -> None:
        current = int(self._conn.execute('PRAGMA user_version').fetchone()[0])
        if current > SCHEMA_VERSION:
            raise RuntimeError(f'scanner DB schema {current} is newer than supported {SCHEMA_VERSION}')
        for version in range(current + 1, SCHEMA_VERSION + 1):
            matches = sorted(self.migrations_dir.glob(f'{version:03d}_*.sql'))
            if len(matches) != 1:
                raise RuntimeError(
                    f'expected exactly one scanner migration for version {version:03d}, found {len(matches)}'
                )
            migration = matches[0]
            self._conn.executescript(migration.read_text(encoding='utf-8'))
            self._conn.execute(f'PRAGMA user_version={version}')
            self._conn.commit()

    def backup(self, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            target = sqlite3.connect(destination)
            try:
                self._conn.backup(target)
            finally:
                target.close()

    def upsert_instruments(self, provider: str, instruments: Iterable[Instrument], deactivate_missing: bool = True) -> dict[str, int]:
        now = int(time.time())
        normalized = list(instruments)
        with self._lock, self._conn:
            if deactivate_missing:
                self._conn.execute('UPDATE instruments SET active=0 WHERE provider=?', (provider,))
            self._conn.executemany(
                '''
                INSERT INTO instruments(provider,symbol,name,exchange,asset_type,active,last_seen_at)
                VALUES(?,?,?,?,?,?,?)
                ON CONFLICT(provider,symbol) DO UPDATE SET
                  name=excluded.name,
                  exchange=excluded.exchange,
                  asset_type=excluded.asset_type,
                  active=excluded.active,
                  last_seen_at=excluded.last_seen_at
                ''',
                [(item.provider, item.symbol, item.name, item.exchange, item.asset_type, 1 if item.active else 0, now) for item in normalized],
            )
            rows = self._conn.execute('SELECT id,symbol FROM instruments WHERE provider=?', (provider,)).fetchall()
        return {str(row['symbol']): int(row['id']) for row in rows}

    def instrument_ids(self, provider: str, symbols: Iterable[str]) -> dict[str, int]:
        values = list(dict.fromkeys(symbols))
        if not values:
            return {}
        placeholders = ','.join('?' for _ in values)
        with self._lock:
            rows = self._conn.execute(
                f'SELECT id,symbol FROM instruments WHERE provider=? AND symbol IN ({placeholders})',
                [provider, *values],
            ).fetchall()
        return {str(row['symbol']): int(row['id']) for row in rows}

    def instrument_age(self, provider: str) -> int | None:
        with self._lock:
            row = self._conn.execute(
                'SELECT MAX(last_seen_at) AS refreshed_at FROM instruments WHERE provider=?',
                (provider,),
            ).fetchone()
        if row is None or row['refreshed_at'] is None:
            return None
        return max(0, int(time.time()) - int(row['refreshed_at']))

    def snapshot_coverage(self, provider: str) -> dict[str, int | None]:
        with self._lock:
            row = self._conn.execute(
                'SELECT COUNT(*) AS active_count, '
                'SUM(CASE WHEN ms.instrument_id IS NOT NULL THEN 1 ELSE 0 END) AS snapshot_count, '
                'MIN(ms.fetched_at) AS oldest_fetched_at '
                'FROM instruments i LEFT JOIN market_snapshot ms ON ms.instrument_id=i.id '
                'WHERE i.provider=? AND i.active=1',
                (provider,),
            ).fetchone()
        if row is None:
            return {'active_count': 0, 'snapshot_count': 0, 'oldest_fetched_at': None}
        return {
            'active_count': int(row['active_count'] or 0),
            'snapshot_count': int(row['snapshot_count'] or 0),
            'oldest_fetched_at': None if row['oldest_fetched_at'] is None else int(row['oldest_fetched_at']),
        }

    def list_active_symbols(self, provider: str) -> list[str]:
        with self._lock:
            rows = self._conn.execute(
                'SELECT symbol FROM instruments WHERE provider=? AND active=1 ORDER BY symbol',
                (provider,),
            ).fetchall()
        return [str(row['symbol']) for row in rows]

    def upsert_snapshots(self, provider: str, snapshots: Iterable[MarketSnapshot], fetched_at: int | None = None) -> None:
        items = list(snapshots)
        if not items:
            return
        ids = self.instrument_ids(provider, [item.symbol for item in items])
        now = int(time.time()) if fetched_at is None else int(fetched_at)
        rows = [(ids[item.symbol], item.price, item.volume, item.market_cap, item.data_time, now) for item in items if item.symbol in ids]
        with self._lock, self._conn:
            self._conn.executemany(
                '''
                INSERT INTO market_snapshot(instrument_id,price,volume,market_cap,data_time,fetched_at)
                VALUES(?,?,?,?,?,?)
                ON CONFLICT(instrument_id) DO UPDATE SET
                  price=COALESCE(excluded.price,market_snapshot.price),
                  volume=COALESCE(excluded.volume,market_snapshot.volume),
                  market_cap=excluded.market_cap,
                  data_time=COALESCE(excluded.data_time,market_snapshot.data_time),
                  fetched_at=excluded.fetched_at
                ''', rows,
            )

    def stage1_candidates(
        self,
        provider: str,
        universes: tuple[str, ...],
        filters: ScanFilters,
        filter_universes_by_exchange: bool = False,
    ) -> list[dict]:
        clauses = ['i.provider=?', 'i.active=1']
        params: list[object] = [provider]
        if universes and filter_universes_by_exchange:
            placeholders = ','.join('?' for _ in universes)
            clauses.append(f'UPPER(i.exchange) IN ({placeholders})')
            params.extend(universes)
        for column, lower, upper in (
            ('ms.price', filters.price_min, filters.price_max),
            ('ms.volume', filters.volume_min, filters.volume_max),
            ('ms.market_cap', filters.market_cap_min, filters.market_cap_max),
        ):
            if lower is not None or upper is not None:
                clauses.append(f'{column} IS NOT NULL')
            if lower is not None:
                clauses.append(f'{column}>=?')
                params.append(lower)
            if upper is not None:
                clauses.append(f'{column}<=?')
                params.append(upper)
        sql = f'''SELECT i.id AS instrument_id,i.symbol,i.name,i.exchange,
                         ms.price,ms.volume,ms.market_cap,ms.data_time,ms.fetched_at
                  FROM instruments i JOIN market_snapshot ms ON ms.instrument_id=i.id
                  WHERE {' AND '.join(clauses)}
                  ORDER BY COALESCE(ms.volume,0) DESC,i.symbol'''
        with self._lock:
            return [dict(row) for row in self._conn.execute(sql, params).fetchall()]

    def upsert_candles(self, instrument_id: int, candles: Iterable[Candle], interval: str = '1d', retain: int = 1000) -> None:
        items = list(candles)
        if not items:
            return
        now = int(time.time())
        with self._lock, self._conn:
            self._conn.executemany(
                '''INSERT INTO candles(instrument_id,interval,time,open,high,low,close,volume,is_closed,updated_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(instrument_id,interval,time) DO UPDATE SET
                     open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,
                     volume=excluded.volume,is_closed=excluded.is_closed,updated_at=excluded.updated_at''',
                [(instrument_id, interval, item.time, item.open, item.high, item.low, item.close, item.volume, 1 if item.is_closed else 0, now) for item in items],
            )
            if retain > 0:
                self._conn.execute(
                    '''DELETE FROM candles WHERE instrument_id=? AND interval=? AND time NOT IN (
                         SELECT time FROM candles WHERE instrument_id=? AND interval=? ORDER BY time DESC LIMIT ?
                       )''',
                    (instrument_id, interval, instrument_id, interval, retain),
                )

    def import_eod_dataset(
        self,
        provider: str,
        instruments: Iterable[Instrument],
        history: dict[str, list[Candle]],
        snapshots: Iterable[MarketSnapshot],
        retain: int = 1000,
        deactivate_missing: bool = False,
        active_max_age_seconds: int | None = None,
    ) -> int:
        """Atomically persist one parsed EOD dataset with bounded candle retention."""
        if active_max_age_seconds is not None and active_max_age_seconds < 0:
            raise ValueError('active_max_age_seconds must be non-negative')
        instrument_items = list(instruments)
        snapshot_items = list(snapshots)
        now = int(time.time())
        inserted = 0
        with self._lock, self._conn:
            if deactivate_missing:
                self._conn.execute('UPDATE instruments SET active=0 WHERE provider=?', (provider,))
            self._conn.executemany(
                '''INSERT INTO instruments(provider,symbol,name,exchange,asset_type,active,last_seen_at)
                   VALUES(?,?,?,?,?,?,?)
                   ON CONFLICT(provider,symbol) DO UPDATE SET
                     name=excluded.name,exchange=excluded.exchange,asset_type=excluded.asset_type,
                     active=excluded.active,last_seen_at=excluded.last_seen_at''',
                [
                    (provider, item.symbol, item.name, item.exchange, item.asset_type, 1 if item.active else 0, now)
                    for item in instrument_items
                ],
            )
            ids = {
                str(row['symbol']): int(row['id'])
                for row in self._conn.execute(
                    'SELECT id,symbol FROM instruments WHERE provider=?', (provider,)
                ).fetchall()
            }
            candle_sql = '''INSERT INTO candles(instrument_id,interval,time,open,high,low,close,volume,is_closed,updated_at)
                            VALUES(?,?,?,?,?,?,?,?,?,?)
                            ON CONFLICT(instrument_id,interval,time) DO UPDATE SET
                              open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,
                              volume=excluded.volume,is_closed=excluded.is_closed,updated_at=excluded.updated_at'''
            for symbol, candles in history.items():
                instrument_id = ids.get(symbol)
                if instrument_id is None or not candles:
                    continue
                rows = [
                    (instrument_id, '1d', item.time, item.open, item.high, item.low, item.close,
                     item.volume, 1 if item.is_closed else 0, now)
                    for item in candles
                ]
                self._conn.executemany(candle_sql, rows)
                inserted += len(rows)
                if retain > 0:
                    self._conn.execute(
                        '''DELETE FROM candles WHERE instrument_id=? AND interval='1d' AND time NOT IN (
                             SELECT time FROM candles WHERE instrument_id=? AND interval='1d' ORDER BY time DESC LIMIT ?
                           )''',
                        (instrument_id, instrument_id, retain),
                    )
            snapshot_rows = [
                (ids[item.symbol], item.price, item.volume, item.market_cap, item.data_time, now)
                for item in snapshot_items if item.symbol in ids
            ]
            self._conn.executemany(
                '''INSERT INTO market_snapshot(instrument_id,price,volume,market_cap,data_time,fetched_at)
                   VALUES(?,?,?,?,?,?)
                   ON CONFLICT(instrument_id) DO UPDATE SET
                     price=COALESCE(excluded.price,market_snapshot.price),
                     volume=COALESCE(excluded.volume,market_snapshot.volume),
                     market_cap=excluded.market_cap,
                     data_time=COALESCE(excluded.data_time,market_snapshot.data_time),
                     fetched_at=excluded.fetched_at''',
                snapshot_rows,
            )
            if active_max_age_seconds is not None:
                latest = self._conn.execute(
                    '''SELECT MAX(ms.data_time) AS latest_data_time
                       FROM market_snapshot ms JOIN instruments i ON i.id=ms.instrument_id
                       WHERE i.provider=?''',
                    (provider,),
                ).fetchone()
                latest_data_time = None if latest is None else latest['latest_data_time']
                if latest_data_time is None:
                    self._conn.execute('UPDATE instruments SET active=0 WHERE provider=?', (provider,))
                else:
                    cutoff = int(latest_data_time) - int(active_max_age_seconds)
                    self._conn.execute(
                        '''UPDATE instruments
                           SET active=CASE WHEN EXISTS (
                               SELECT 1 FROM market_snapshot ms
                               WHERE ms.instrument_id=instruments.id AND ms.data_time>=?
                           ) THEN 1 ELSE 0 END
                           WHERE provider=?''',
                        (cutoff, provider),
                    )
        return inserted

    def read_candles(self, instrument_id: int, interval: str = '1d', limit: int = 1000) -> list[Candle]:
        with self._lock:
            rows = self._conn.execute(
                '''SELECT time,open,high,low,close,volume,is_closed FROM candles
                   WHERE instrument_id=? AND interval=? ORDER BY time DESC LIMIT ?''',
                (instrument_id, interval, limit),
            ).fetchall()
        return [
            Candle(
                time=int(row['time']), open=float(row['open']), high=float(row['high']),
                low=float(row['low']), close=float(row['close']),
                volume=None if row['volume'] is None else float(row['volume']),
                is_closed=bool(row['is_closed']),
            )
            for row in reversed(rows)
        ]

    def candle_state(self, instrument_id: int, interval: str = '1d') -> dict | None:
        with self._lock:
            row = self._conn.execute(
                '''SELECT COUNT(*) AS count,MIN(time) AS first_time,MAX(time) AS last_time,MAX(updated_at) AS updated_at
                   FROM candles WHERE instrument_id=? AND interval=?''',
                (instrument_id, interval),
            ).fetchone()
        if row is None or not row['count']:
            return None
        return dict(row)

    def upsert_ha_metrics(self, instrument_id: int, metrics: Iterable[object], algo_version: int) -> None:
        now = int(time.time())
        rows = [(instrument_id, item.timeframe, item.kind, item.candle_time, item.ha_open, item.ha_high, item.ha_low, item.ha_close, 1 if item.green else 0, 1 if item.no_lower_wick else 0, item.ha_close_change_pct, item.ha_body_pct, algo_version, item.source_last_time, now) for item in metrics]
        if not rows:
            return
        with self._lock, self._conn:
            self._conn.executemany(
                '''INSERT INTO ha_latest(instrument_id,timeframe,kind,candle_time,ha_open,ha_high,ha_low,ha_close,green,no_lower_wick,ha_close_change_pct,ha_body_pct,algo_version,source_last_time,computed_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(instrument_id,timeframe,kind) DO UPDATE SET
                     candle_time=excluded.candle_time,ha_open=excluded.ha_open,ha_high=excluded.ha_high,
                     ha_low=excluded.ha_low,ha_close=excluded.ha_close,green=excluded.green,
                     no_lower_wick=excluded.no_lower_wick,ha_close_change_pct=excluded.ha_close_change_pct,
                     ha_body_pct=excluded.ha_body_pct,algo_version=excluded.algo_version,
                     source_last_time=excluded.source_last_time,computed_at=excluded.computed_at''', rows,
            )

    def ha_is_current(self, instrument_id: int, timeframe: str, kind: str, source_last_time: int, algo_version: int) -> bool:
        with self._lock:
            row = self._conn.execute(
                '''SELECT 1 FROM ha_latest WHERE instrument_id=? AND timeframe=? AND kind=? AND source_last_time=? AND algo_version=?''',
                (instrument_id, timeframe, kind, source_last_time, algo_version),
            ).fetchone()
        return row is not None

    def query_final(self, provider: str, filters: ScanFilters, heikin: HeikinScan, instrument_ids: list[int]) -> list[dict]:
        if not instrument_ids:
            return []
        placeholders = ','.join('?' for _ in instrument_ids)
        clauses = [f'i.id IN ({placeholders})', 'i.provider=?', 'h.timeframe=?', 'h.kind=?']
        params: list[object] = [*instrument_ids, provider, heikin.timeframe, heikin.candle]
        if heikin.green:
            clauses.append('h.green=1')
        if heikin.no_lower_wick:
            clauses.append('h.no_lower_wick=1')
        if heikin.close_change_pct_min is not None:
            clauses.append('h.ha_close_change_pct IS NOT NULL AND h.ha_close_change_pct>=?')
            params.append(heikin.close_change_pct_min)
        sql = f'''SELECT i.id AS instrument_id,i.symbol,i.name,i.exchange,
                         ms.price,ms.volume,ms.market_cap,ms.data_time,ms.fetched_at,
                         h.candle_time,h.ha_open,h.ha_high,h.ha_low,h.ha_close,h.green,h.no_lower_wick,
                         h.ha_close_change_pct,h.ha_body_pct,h.source_last_time,h.computed_at
                  FROM instruments i JOIN market_snapshot ms ON ms.instrument_id=i.id
                  JOIN ha_latest h ON h.instrument_id=i.id
                  WHERE {' AND '.join(clauses)}
                  ORDER BY h.ha_close_change_pct DESC,i.symbol'''
        with self._lock:
            return [dict(row) for row in self._conn.execute(sql, params).fetchall()]

    def begin_eod_import(
        self,
        provider: str,
        source: str,
        mode: str,
        adjusted: bool,
        source_url: str | None,
        source_sha256: str | None,
    ) -> int:
        with self._lock, self._conn:
            cursor = self._conn.execute(
                '''INSERT INTO eod_import_runs(provider,source,mode,adjusted,source_url,source_sha256,started_at,status)
                   VALUES(?,?,?,?,?,?,?,?)''',
                (provider, source, mode, 1 if adjusted else 0, source_url, source_sha256, int(time.time()), 'running'),
            )
            return int(cursor.lastrowid)

    def finish_eod_import(
        self,
        import_id: int,
        *,
        status: str,
        trade_date: int | None = None,
        member_count: int = 0,
        row_count: int = 0,
        symbol_count: int = 0,
        inserted_candle_count: int = 0,
        error: str | None = None,
    ) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                '''UPDATE eod_import_runs SET trade_date=?,finished_at=?,member_count=?,row_count=?,symbol_count=?,
                          inserted_candle_count=?,status=?,error=? WHERE id=?''',
                (trade_date, int(time.time()), member_count, row_count, symbol_count,
                 inserted_candle_count, status, error, import_id),
            )

    def latest_successful_import(self, provider: str) -> dict | None:
        with self._lock:
            row = self._conn.execute(
                '''SELECT * FROM eod_import_runs WHERE provider=? AND status='complete'
                   ORDER BY COALESCE(trade_date,0) DESC,COALESCE(finished_at,0) DESC LIMIT 1''',
                (provider,),
            ).fetchone()
        return None if row is None else dict(row)

    def begin_scan(self, provider: str, filters_json: dict) -> int:
        with self._lock, self._conn:
            cursor = self._conn.execute(
                'INSERT INTO scan_runs(provider,started_at,filters_json,status) VALUES(?,?,?,?)',
                (provider, int(time.time()), json.dumps(filters_json, separators=(',', ':')), 'running'),
            )
            return int(cursor.lastrowid)

    def update_scan(self, run_id: int, **fields: object) -> None:
        allowed = {'finished_at', 'universe_count', 'stage1_count', 'history_refresh_count', 'stage2_count', 'result_count', 'status', 'error'}
        updates = [(key, value) for key, value in fields.items() if key in allowed]
        if not updates:
            return
        sql = 'UPDATE scan_runs SET ' + ','.join(f'{key}=?' for key, _ in updates) + ' WHERE id=?'
        with self._lock, self._conn:
            self._conn.execute(sql, [*(value for _, value in updates), run_id])

    def get_scan(self, run_id: int) -> dict | None:
        with self._lock:
            row = self._conn.execute('SELECT * FROM scan_runs WHERE id=?', (run_id,)).fetchone()
        if row is None:
            return None
        payload = dict(row)
        try:
            payload['filters'] = json.loads(payload.pop('filters_json'))
        except Exception:
            payload['filters'] = {}
            payload.pop('filters_json', None)
        return payload

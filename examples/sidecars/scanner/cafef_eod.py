from __future__ import annotations

import argparse
import csv
import hashlib
import html as html_lib
import io
import json
import math
import os
import re
import sys
import unicodedata
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Iterable
from zoneinfo import ZoneInfo

from db import ScannerDB
from models import Candle, Instrument, MarketSnapshot

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_DB_PATH = BASE_DIR / 'data' / 'scanner.db'
DEFAULT_DOWNLOAD_PAGE = 'https://cafef.vn/du-lieu/du-lieu-download.chn'
VN_TZ = ZoneInfo('Asia/Ho_Chi_Minh')
PROVIDER_ID = 'vn_eod'
SOURCE_NAME = 'cafef'
HISTORY_RETAIN_BARS = 1000
ACTIVE_MAX_AGE_DAYS = 30
ACTIVE_MAX_AGE_SECONDS = ACTIVE_MAX_AGE_DAYS * 24 * 60 * 60
MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 64
TEXT_SUFFIXES = {'.txt', '.csv', '.dat'}
DOWNLOAD_TIMEOUT_SECONDS = 30
USER_AGENT = 'my-chart2-cafef-eod/1.0'

_HEADER_ALIASES = {
    'symbol': {'ticker', 'symbol', 'mack', 'ma', 'code', 'stockcode'},
    'date': {'date', 'dtyyyymmdd', 'yyyymmdd', 'tradingdate', 'ngay'},
    'open': {'open', 'openprice', 'mocua', 'giamocua'},
    'high': {'high', 'highprice', 'caonhat', 'giacaonhat'},
    'low': {'low', 'lowprice', 'thapnhat', 'giathapnhat'},
    'close': {'close', 'closeprice', 'dongcua', 'giadongcua'},
    'volume': {'volume', 'vol', 'khoiluong', 'totalvolume'},
    'exchange': {'exchange', 'market', 'san', 'floor'},
}


@dataclass(frozen=True)
class EodRecord:
    symbol: str
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float | None
    exchange: str


@dataclass(frozen=True)
class ParsedArchive:
    records: tuple[EodRecord, ...]
    member_count: int
    row_count: int


class CafeFImportError(RuntimeError):
    pass


def _normalize_header(value: str) -> str:
    normalized = unicodedata.normalize('NFKD', value.strip().strip('<>'))
    ascii_value = normalized.encode('ascii', 'ignore').decode('ascii').lower()
    return re.sub(r'[^a-z0-9]+', '', ascii_value)


def _header_indices(row: list[str]) -> dict[str, int] | None:
    normalized = [_normalize_header(value) for value in row]
    result: dict[str, int] = {}
    for field, aliases in _HEADER_ALIASES.items():
        for index, value in enumerate(normalized):
            if value in aliases:
                result[field] = index
                break
    required = {'date', 'open', 'high', 'low', 'close'}
    return result if required.issubset(result) else None


def _decode_member(data: bytes) -> str:
    for encoding in ('utf-8-sig', 'utf-8', 'cp1258', 'latin-1'):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise CafeFImportError('archive member cannot be decoded as text')


def _detect_delimiter(text: str) -> str:
    sample_lines = [line for line in text.splitlines() if line.strip()][:8]
    if not sample_lines:
        return ','
    sample = '\n'.join(sample_lines)
    candidates = [',', ';', '\t', '|']
    counts = {delimiter: sample.count(delimiter) for delimiter in candidates}
    delimiter = max(candidates, key=lambda item: counts[item])
    return delimiter if counts[delimiter] > 0 else ','


def _parse_float(value: str, *, allow_none: bool = False) -> float | None:
    text = value.strip().strip('"').replace('\u00a0', '').replace(' ', '')
    if not text or text.upper() in {'NULL', 'N/A', 'NA', '-'}:
        if allow_none:
            return None
        raise ValueError('missing number')
    if ',' in text and '.' not in text:
        text = text.replace(',', '.')
    elif ',' in text and '.' in text:
        text = text.replace(',', '')
    number = float(text)
    if not math.isfinite(number):
        raise ValueError('non-finite number')
    return number


def _parse_date(value: str) -> int:
    text = value.strip().strip('"')
    formats = ('%Y%m%d', '%Y-%m-%d', '%d/%m/%Y', '%d-%m-%Y', '%Y/%m/%d')
    parsed: datetime | None = None
    for fmt in formats:
        try:
            parsed = datetime.strptime(text, fmt)
            break
        except ValueError:
            continue
    if parsed is None:
        raise ValueError(f'unsupported date: {text}')
    return int(parsed.replace(tzinfo=VN_TZ).timestamp())


def _normalize_symbol(value: str) -> str:
    symbol = value.strip().strip('"').upper()
    if not symbol or len(symbol) > 20 or not re.fullmatch(r'[A-Z0-9._-]+', symbol):
        raise ValueError('invalid symbol')
    return symbol


def normalize_exchange(value: str) -> str:
    normalized = re.sub(r'[^A-Z0-9]+', '', value.upper())
    if normalized in {'HOSE', 'HSX', 'HCM', 'HOCHIMINH'}:
        return 'HOSE'
    if normalized in {'HNX', 'HANOI'}:
        return 'HNX'
    if normalized in {'UPCOM', 'UPCOMINDEX'}:
        return 'UPCOM'
    return ''


def infer_exchange(member_name: str) -> str:
    normalized = re.sub(r'[^A-Z0-9]+', ' ', member_name.upper())
    tokens = set(normalized.split())
    if tokens & {'HOSE', 'HSX'}:
        return 'HOSE'
    if 'HNX' in tokens:
        return 'HNX'
    if tokens & {'UPCOM', 'UPC'}:
        return 'UPCOM'
    return ''


def _symbol_from_member(member_name: str) -> str:
    stem = PurePosixPath(member_name).stem.upper()
    if re.fullmatch(r'[A-Z]{2,5}', stem) and stem not in {'CAFEF', 'HOSE', 'HSX', 'HNX', 'UPCOM'}:
        return stem
    return ''


def _valid_ohlc(open_price: float, high: float, low: float, close: float) -> bool:
    return (
        min(open_price, high, low, close) > 0
        and high >= max(open_price, low, close)
        and low <= min(open_price, high, close)
    )


def _record_from_header(row: list[str], indices: dict[str, int], member_name: str) -> EodRecord:
    fallback_symbol = _symbol_from_member(member_name)
    symbol_index = indices.get('symbol')
    if symbol_index is None and not fallback_symbol:
        raise ValueError('missing symbol')
    symbol = _normalize_symbol(row[symbol_index]) if symbol_index is not None else fallback_symbol
    timestamp = _parse_date(row[indices['date']])
    open_price = _parse_float(row[indices['open']])
    high = _parse_float(row[indices['high']])
    low = _parse_float(row[indices['low']])
    close = _parse_float(row[indices['close']])
    assert open_price is not None and high is not None and low is not None and close is not None
    if not _valid_ohlc(open_price, high, low, close):
        raise ValueError('invalid OHLC')
    volume_index = indices.get('volume')
    volume = _parse_float(row[volume_index], allow_none=True) if volume_index is not None else None
    if volume is not None and volume < 0:
        raise ValueError('negative volume')
    exchange_index = indices.get('exchange')
    exchange = normalize_exchange(row[exchange_index]) if exchange_index is not None else ''
    return EodRecord(
        symbol, timestamp, open_price, high, low, close, volume,
        exchange or infer_exchange(member_name),
    )


def _record_from_position(row: list[str], member_name: str) -> EodRecord:
    if len(row) >= 8 and row[1].strip().upper() in {'D', 'DAY', 'DAILY'}:
        symbol_i, date_i, open_i, high_i, low_i, close_i, volume_i = 0, 2, 3, 4, 5, 6, 7
    elif len(row) >= 7:
        symbol_i, date_i, open_i, high_i, low_i, close_i, volume_i = 0, 1, 2, 3, 4, 5, 6
    else:
        raise ValueError('unsupported positional row')
    symbol = _normalize_symbol(row[symbol_i])
    timestamp = _parse_date(row[date_i])
    open_price = _parse_float(row[open_i])
    high = _parse_float(row[high_i])
    low = _parse_float(row[low_i])
    close = _parse_float(row[close_i])
    assert open_price is not None and high is not None and low is not None and close is not None
    if not _valid_ohlc(open_price, high, low, close):
        raise ValueError('invalid OHLC')
    volume = _parse_float(row[volume_i], allow_none=True)
    if volume is not None and volume < 0:
        raise ValueError('negative volume')
    return EodRecord(
        symbol, timestamp, open_price, high, low, close, volume,
        infer_exchange(member_name),
    )


def parse_text_member(text: str, member_name: str) -> tuple[list[EodRecord], int]:
    delimiter = _detect_delimiter(text)
    rows = [
        [cell.strip() for cell in row]
        for row in csv.reader(io.StringIO(text), delimiter=delimiter)
        if any(cell.strip() for cell in row)
    ]
    if not rows:
        return [], 0
    header = _header_indices(rows[0])
    start = 1 if header is not None else 0
    parsed: dict[tuple[str, int], EodRecord] = {}
    attempted = 0
    for row in rows[start:]:
        if not row or row[0].lstrip().startswith(('#', '$')):
            continue
        attempted += 1
        try:
            record = _record_from_header(row, header, member_name) if header is not None else _record_from_position(row, member_name)
        except (IndexError, TypeError, ValueError):
            continue
        parsed[(record.symbol, record.time)] = record
    return list(parsed.values()), attempted


def _is_text_member(name: str) -> bool:
    path = PurePosixPath(name)
    suffix = path.suffix.lower()
    return not name.endswith('/') and (suffix in TEXT_SUFFIXES or not suffix)


def parse_archive(archive_bytes: bytes) -> ParsedArchive:
    if len(archive_bytes) > MAX_ARCHIVE_BYTES:
        raise CafeFImportError('CafeF archive exceeds size limit')
    try:
        archive = zipfile.ZipFile(io.BytesIO(archive_bytes))
    except zipfile.BadZipFile as exc:
        raise CafeFImportError('CafeF payload is not a valid ZIP archive') from exc

    records: dict[tuple[str, int], EodRecord] = {}
    member_count = 0
    row_count = 0
    total_uncompressed = 0
    with archive:
        infos = archive.infolist()
        if len(infos) > MAX_ARCHIVE_MEMBERS:
            raise CafeFImportError('CafeF archive contains too many members')
        for info in infos:
            if not _is_text_member(info.filename):
                continue
            total_uncompressed += int(info.file_size)
            if total_uncompressed > MAX_UNCOMPRESSED_BYTES:
                raise CafeFImportError('CafeF archive exceeds uncompressed size limit')
            member_count += 1
            text = _decode_member(archive.read(info))
            member_records, attempted = parse_text_member(text, info.filename)
            row_count += attempted
            for record in member_records:
                records[(record.symbol, record.time)] = record
    if member_count == 0:
        raise CafeFImportError('CafeF archive has no supported text data members')
    if not records:
        raise CafeFImportError('CafeF archive contains no valid OHLCV rows')
    ordered = tuple(sorted(records.values(), key=lambda item: (item.symbol, item.time)))
    return ParsedArchive(ordered, member_count, row_count)


def _download_pattern(mode: str) -> re.Pattern[str]:
    if mode == 'eod':
        return re.compile(r'CafeF\.SolieuGD\.(\d{8})\.zip', re.IGNORECASE)
    if mode == 'upto':
        return re.compile(r'CafeF\.SolieuGD\.Upto(\d{8})\.zip', re.IGNORECASE)
    raise ValueError(f'unsupported mode: {mode}')


def discover_latest_url(page_html: str, mode: str, page_url: str = DEFAULT_DOWNLOAD_PAGE) -> str:
    pattern = _download_pattern(mode)
    candidates: list[tuple[datetime, str]] = []
    for match in re.finditer(r'href\s*=\s*["\']([^"\']+)["\']', page_html, re.IGNORECASE):
        href = html_lib.unescape(match.group(1))
        file_match = pattern.search(href)
        if file_match is None:
            continue
        try:
            trade_date = datetime.strptime(file_match.group(1), '%d%m%Y')
        except ValueError:
            continue
        candidates.append((trade_date, urllib.parse.urljoin(page_url, href)))
    if not candidates:
        raise CafeFImportError(f'no adjusted CafeF {mode} download link found')
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def fetch_bytes(url: str, max_bytes: int = MAX_ARCHIVE_BYTES) -> bytes:
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept': '*/*'})
    try:
        with urllib.request.urlopen(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
            content_length = response.headers.get('Content-Length')
            if content_length and int(content_length) > max_bytes:
                raise CafeFImportError('CafeF download exceeds size limit')
            payload = response.read(max_bytes + 1)
    except CafeFImportError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise CafeFImportError(f'CafeF download failed: {exc}') from exc
    if len(payload) > max_bytes:
        raise CafeFImportError('CafeF download exceeds size limit')
    return payload


def fetch_text(url: str) -> str:
    payload = fetch_bytes(url, max_bytes=4 * 1024 * 1024)
    return _decode_member(payload)


def _dataset(parsed: ParsedArchive) -> tuple[list[Instrument], dict[str, list[Candle]], list[MarketSnapshot], int]:
    grouped: dict[str, list[EodRecord]] = {}
    for record in parsed.records:
        grouped.setdefault(record.symbol, []).append(record)

    instruments: list[Instrument] = []
    history: dict[str, list[Candle]] = {}
    snapshots: list[MarketSnapshot] = []
    latest_trade_time = 0
    for symbol, records in grouped.items():
        records.sort(key=lambda item: item.time)
        bounded = records[-HISTORY_RETAIN_BARS:]
        exchange = next((item.exchange for item in reversed(records) if item.exchange), '')
        instruments.append(Instrument('vn_eod', symbol, symbol, exchange, 'STOCK', True))
        candles = [
            Candle(item.time, item.open, item.high, item.low, item.close, item.volume, True)
            for item in bounded
        ]
        history[symbol] = candles
        latest = records[-1]
        latest_trade_time = max(latest_trade_time, latest.time)
        snapshots.append(MarketSnapshot(symbol, latest.close, latest.volume, None, latest.time))
    instruments.sort(key=lambda item: item.symbol)
    return instruments, history, snapshots, latest_trade_time


def import_archive(
    db: ScannerDB,
    archive_bytes: bytes,
    *,
    mode: str,
    source_url: str | None,
) -> dict[str, object]:
    if mode not in {'eod', 'upto'}:
        raise ValueError('mode must be eod or upto')
    source_sha256 = hashlib.sha256(archive_bytes).hexdigest()
    audit_id = db.begin_eod_import(
        PROVIDER_ID,
        SOURCE_NAME,
        mode,
        True,
        source_url,
        source_sha256,
    )
    try:
        parsed = parse_archive(archive_bytes)
        instruments, history, snapshots, trade_date = _dataset(parsed)
        inserted = db.import_eod_dataset(
            PROVIDER_ID,
            instruments,
            history,
            snapshots,
            retain=HISTORY_RETAIN_BARS,
            deactivate_missing=mode == 'upto',
            active_max_age_seconds=ACTIVE_MAX_AGE_SECONDS,
        )
        coverage = db.snapshot_coverage(PROVIDER_ID)
        db.finish_eod_import(
            audit_id,
            status='complete',
            trade_date=trade_date,
            member_count=parsed.member_count,
            row_count=parsed.row_count,
            symbol_count=len(instruments),
            inserted_candle_count=inserted,
        )
        return {
            'ok': True,
            'importId': audit_id,
            'mode': mode,
            'tradeDate': trade_date,
            'members': parsed.member_count,
            'rows': parsed.row_count,
            'symbols': len(instruments),
            'activeSymbols': coverage['active_count'],
            'candles': inserted,
            'sha256': source_sha256,
            'source': source_url,
        }
    except Exception as exc:  # noqa: BLE001
        db.finish_eod_import(audit_id, status='error', error=str(exc)[:500])
        raise


def _db_path(raw: str | None) -> Path:
    if raw:
        return Path(raw)
    return Path(os.environ.get('SCANNER_DB_PATH', str(DEFAULT_DB_PATH)))


def _open_db(path: Path) -> ScannerDB:
    return ScannerDB(path, BASE_DIR / 'migrations')


def _import_latest(db: ScannerDB, mode: str) -> dict[str, object]:
    page_url = os.environ.get('CAFEF_DOWNLOAD_PAGE', DEFAULT_DOWNLOAD_PAGE)
    page_html = fetch_text(page_url)
    archive_url = discover_latest_url(page_html, mode, page_url)
    return import_archive(db, fetch_bytes(archive_url), mode=mode, source_url=archive_url)


def _print_json(value: object) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True))


def build_cli() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description='Import adjusted CafeF EOD data into scanner SQLite.')
    parser.add_argument('--db', help='Scanner SQLite path; defaults to SCANNER_DB_PATH/data/scanner.db.')
    subparsers = parser.add_subparsers(dest='command', required=True)

    latest = subparsers.add_parser('import-latest', help='Discover and import the latest adjusted CafeF package.')
    latest.add_argument('--mode', choices=('eod', 'upto'), default='eod')

    url_parser = subparsers.add_parser('import-url', help='Import an explicit CafeF ZIP URL.')
    url_parser.add_argument('url')
    url_parser.add_argument('--mode', choices=('eod', 'upto'), default='eod')

    file_parser = subparsers.add_parser('import-file', help='Import a local CafeF ZIP archive.')
    file_parser.add_argument('path')
    file_parser.add_argument('--mode', choices=('eod', 'upto'), default='eod')

    subparsers.add_parser('status', help='Show the latest successful VN EOD import and DB coverage.')
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = build_cli().parse_args(list(argv) if argv is not None else None)
    db = _open_db(_db_path(args.db))
    try:
        if args.command == 'import-latest':
            result = _import_latest(db, args.mode)
        elif args.command == 'import-url':
            result = import_archive(db, fetch_bytes(args.url), mode=args.mode, source_url=args.url)
        elif args.command == 'import-file':
            path = Path(args.path).expanduser().resolve()
            result = import_archive(db, path.read_bytes(), mode=args.mode, source_url=str(path))
        elif args.command == 'status':
            result = {
                'database': str(db.path),
                'activeMaxAgeDays': ACTIVE_MAX_AGE_DAYS,
                'latestImport': db.latest_successful_import(PROVIDER_ID),
                'coverage': db.snapshot_coverage(PROVIDER_ID),
            }
        else:
            raise AssertionError(f'unhandled command: {args.command}')
        _print_json(result)
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f'CafeF EOD import failed: {exc}', file=sys.stderr)
        return 1
    finally:
        db.close()


if __name__ == '__main__':
    raise SystemExit(main())

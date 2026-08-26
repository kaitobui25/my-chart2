from __future__ import annotations

import csv
import io
import zipfile
from collections.abc import Callable, Iterator
from datetime import datetime
from functools import lru_cache
from itertools import chain

from cafef_eod import (
    MAX_ARCHIVE_BYTES,
    MAX_ARCHIVE_MEMBERS,
    MAX_UNCOMPRESSED_BYTES,
    VN_TZ,
    CafeFImportError,
    EodRecord,
    ParsedArchive,
    _decode_member,
    _detect_delimiter,
    _header_indices,
    _is_text_member,
    _normalize_symbol,
    _parse_date,
    _parse_float,
    _symbol_from_member,
    _valid_ohlc,
    infer_exchange,
    normalize_exchange,
)

ArchiveProgress = Callable[[int, int, int, int, int], None]
PROGRESS_ROW_STEP = 25_000


@lru_cache(maxsize=8192)
def _parse_date_cached(value: str) -> int:
    text = value.strip().strip('"')
    if len(text) == 8 and text.isdigit():
        year = int(text[:4])
        if 1900 <= year <= 2200:
            parsed = datetime(year, int(text[4:6]), int(text[6:8]), tzinfo=VN_TZ)
            return int(parsed.timestamp())
    return _parse_date(text)


def _record_from_header(row: list[str], indices: dict[str, int], member_name: str) -> EodRecord:
    fallback_symbol = _symbol_from_member(member_name)
    symbol_index = indices.get('symbol')
    if symbol_index is None and not fallback_symbol:
        raise ValueError('missing symbol')
    symbol = _normalize_symbol(row[symbol_index]) if symbol_index is not None else fallback_symbol
    timestamp = _parse_date_cached(row[indices['date']])
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
        symbol,
        timestamp,
        open_price,
        high,
        low,
        close,
        volume,
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
    timestamp = _parse_date_cached(row[date_i])
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
        symbol,
        timestamp,
        open_price,
        high,
        low,
        close,
        volume,
        infer_exchange(member_name),
    )


def _row_time(row: list[str], header: dict[str, int] | None) -> int | None:
    try:
        if header is not None:
            date_i = header['date']
        elif len(row) >= 8 and row[1].strip().upper() in {'D', 'DAY', 'DAILY'}:
            date_i = 2
        elif len(row) >= 7:
            date_i = 1
        else:
            return None
        return _parse_date_cached(row[date_i])
    except (IndexError, TypeError, ValueError):
        return None


def _decoded_lines(raw) -> Iterator[str]:
    for raw_line in raw:
        yield _decode_member(raw_line)


def _stream_rows(raw) -> Iterator[list[str]]:
    decoded = _decoded_lines(raw)
    prefix: list[str] = []
    sample: list[str] = []
    for line in decoded:
        prefix.append(line)
        if line.strip():
            sample.append(line)
        if len(sample) >= 8:
            break
    delimiter = _detect_delimiter(''.join(sample))
    yield from csv.reader(chain(prefix, decoded), delimiter=delimiter)


def _parse_member(
    raw,
    member_name: str,
    *,
    bytes_before: int,
    total_bytes: int,
    member_index: int,
    member_total: int,
    rows_before: int,
    progress: ArchiveProgress | None,
    min_time: int | None,
) -> tuple[dict[tuple[str, int], EodRecord], int]:
    parsed: dict[tuple[str, int], EodRecord] = {}
    attempted = 0
    header_checked = False
    header: dict[str, int] | None = None

    for raw_row in _stream_rows(raw):
        row = [cell.strip() for cell in raw_row]
        if not row or not any(row):
            continue
        if not header_checked:
            header = _header_indices(row)
            header_checked = True
            if header is not None:
                continue
        if row[0].lstrip().startswith(('#', '$')):
            continue
        attempted += 1

        row_time = _row_time(row, header) if min_time is not None else None
        if min_time is None or row_time is None or row_time >= min_time:
            try:
                record = (
                    _record_from_header(row, header, member_name)
                    if header is not None
                    else _record_from_position(row, member_name)
                )
            except (IndexError, TypeError, ValueError):
                record = None
            if record is not None:
                parsed[(record.symbol, record.time)] = record

        if progress is not None and attempted % PROGRESS_ROW_STEP == 0:
            try:
                member_bytes = int(raw.tell())
            except (AttributeError, OSError):
                member_bytes = 0
            progress(
                min(total_bytes, bytes_before + max(0, member_bytes)),
                total_bytes,
                member_index,
                member_total,
                rows_before + attempted,
            )
    return parsed, attempted


def parse_archive_streaming(
    archive_bytes: bytes,
    *,
    progress: ArchiveProgress | None = None,
    min_time: int | None = None,
) -> ParsedArchive:
    """Parse CafeF ZIP incrementally, optionally skipping rows older than `min_time`."""
    if len(archive_bytes) > MAX_ARCHIVE_BYTES:
        raise CafeFImportError('CafeF archive exceeds size limit')
    try:
        archive = zipfile.ZipFile(io.BytesIO(archive_bytes))
    except zipfile.BadZipFile as exc:
        raise CafeFImportError('CafeF payload is not a valid ZIP archive') from exc

    records: dict[tuple[str, int], EodRecord] = {}
    row_count = 0
    with archive:
        infos = archive.infolist()
        if len(infos) > MAX_ARCHIVE_MEMBERS:
            raise CafeFImportError('CafeF archive contains too many members')

        text_infos = []
        total_uncompressed = 0
        for info in infos:
            if not _is_text_member(info.filename):
                continue
            total_uncompressed += int(info.file_size)
            if total_uncompressed > MAX_UNCOMPRESSED_BYTES:
                raise CafeFImportError('CafeF archive exceeds uncompressed size limit')
            text_infos.append(info)

        if not text_infos:
            raise CafeFImportError('CafeF archive has no supported text data members')

        bytes_done = 0
        if progress is not None:
            progress(0, total_uncompressed, 0, len(text_infos), 0)

        for member_index, info in enumerate(text_infos, start=1):
            with archive.open(info, 'r') as raw:
                member_records, attempted = _parse_member(
                    raw,
                    info.filename,
                    bytes_before=bytes_done,
                    total_bytes=total_uncompressed,
                    member_index=member_index,
                    member_total=len(text_infos),
                    rows_before=row_count,
                    progress=progress,
                    min_time=min_time,
                )
            row_count += attempted
            records.update(member_records)
            bytes_done += int(info.file_size)
            if progress is not None:
                progress(bytes_done, total_uncompressed, member_index, len(text_infos), row_count)

    if not records:
        raise CafeFImportError('CafeF archive contains no valid OHLCV rows')
    ordered = tuple(sorted(records.values(), key=lambda item: (item.symbol, item.time)))
    return ParsedArchive(ordered, len(text_infos), row_count)

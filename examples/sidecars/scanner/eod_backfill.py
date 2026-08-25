from __future__ import annotations

import hashlib
import os
import sqlite3
from collections.abc import Callable
from datetime import timedelta
from pathlib import Path

from cafef_eod import (
    ACTIVE_MAX_AGE_SECONDS,
    DEFAULT_DOWNLOAD_PAGE,
    HISTORY_RETAIN_BARS,
    PROVIDER_ID,
    SOURCE_NAME,
    ParsedArchive,
    _dataset,
    discover_latest_url,
    fetch_bytes,
    fetch_text,
    reclassify_active_universe,
)
from cafef_stream import parse_archive_streaming

LOOKBACK_DAYS = 365
ProgressCallback = Callable[[int, str], None]


def _report(progress: ProgressCallback | None, percent: int, stage: str) -> None:
    if progress is None:
        return
    progress(max(0, min(100, int(percent))), stage)


def _local_keys(db_path: Path, cutoff: int) -> set[tuple[str, int]]:
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            '''SELECT i.symbol,c.time
               FROM candles c
               JOIN instruments i ON i.id=c.instrument_id
               WHERE i.provider=? AND c.interval='1d' AND c.time>=?''',
            (PROVIDER_ID, cutoff),
        ).fetchall()
        return {(str(symbol), int(candle_time)) for symbol, candle_time in rows}
    finally:
        conn.close()


def _import_parsed_archive(
    db,
    archive_bytes: bytes,
    parsed: ParsedArchive,
    *,
    source_url: str,
) -> dict[str, object]:
    """Import an already parsed CafeF Upto payload without parsing the ZIP again."""
    source_sha256 = hashlib.sha256(archive_bytes).hexdigest()
    audit_id = db.begin_eod_import(
        PROVIDER_ID,
        SOURCE_NAME,
        'upto',
        True,
        source_url,
        source_sha256,
    )
    try:
        instruments, history, snapshots, trade_date = _dataset(parsed)
        inserted = db.import_eod_dataset(
            PROVIDER_ID,
            instruments,
            history,
            snapshots,
            retain=HISTORY_RETAIN_BARS,
            deactivate_missing=True,
            active_max_age_seconds=ACTIVE_MAX_AGE_SECONDS,
        )
        asset_types = reclassify_active_universe(db)
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
            'mode': 'upto',
            'tradeDate': trade_date,
            'members': parsed.member_count,
            'rows': parsed.row_count,
            'symbols': len(instruments),
            'activeSymbols': coverage['active_count'],
            'assetTypes': asset_types,
            'candles': inserted,
            'sha256': source_sha256,
            'source': source_url,
        }
    except Exception as exc:  # noqa: BLE001
        db.finish_eod_import(audit_id, status='error', error=str(exc)[:500])
        raise


def repair_recent_year(
    db,
    *,
    lookback_days: int = LOOKBACK_DAYS,
    progress: ProgressCallback | None = None,
) -> dict[str, object]:
    """Use the latest CafeF Upto archive to repair missing local daily candles.

    The integrity comparison is limited to the most recent `lookback_days`, while
    the existing CafeF importer keeps the normal per-symbol retention policy.
    The ZIP is streamed row-by-row and parsed only once.
    """
    if lookback_days <= 0:
        raise ValueError('lookback_days must be positive')

    _report(progress, 2, 'Đọc trang tải CafeF')
    page_url = os.environ.get('CAFEF_DOWNLOAD_PAGE', DEFAULT_DOWNLOAD_PAGE)
    page_html = fetch_text(page_url)

    _report(progress, 10, 'Tìm gói CafeF Upto mới nhất')
    archive_url = discover_latest_url(page_html, 'upto', page_url)

    _report(progress, 18, 'Tải gói CafeF Upto')
    archive_bytes = fetch_bytes(archive_url)
    archive_mb = len(archive_bytes) / (1024 * 1024)

    _report(progress, 35, f'Tải xong ZIP {archive_mb:.1f} MB · bắt đầu parse streaming')

    def parse_progress(
        processed_bytes: int,
        total_bytes: int,
        member_index: int,
        member_total: int,
        row_count: int,
    ) -> None:
        total = max(1, total_bytes)
        ratio = max(0.0, min(1.0, processed_bytes / total))
        percent = 35 + int(ratio * 14)
        processed_mb = processed_bytes / (1024 * 1024)
        total_mb = total_bytes / (1024 * 1024)
        file_label = f'{member_index}/{member_total}' if member_total else '0/0'
        _report(
            progress,
            percent,
            f'Parse streaming {processed_mb:.1f}/{total_mb:.1f} MB giải nén · '
            f'file {file_label} · {row_count:,} dòng',
        )

    parsed = parse_archive_streaming(archive_bytes, progress=parse_progress)
    if not parsed.records:
        raise LookupError('CafeF Upto archive không có dữ liệu để backfill')

    _report(
        progress,
        50,
        f'Parse xong 1 lần · {parsed.member_count:,} file · {parsed.row_count:,} dòng · '
        f'{len(parsed.records):,} record hợp lệ · đang so SQLite local 1 năm',
    )
    latest_time = max(int(record.time) for record in parsed.records)
    cutoff = latest_time - int(timedelta(days=lookback_days).total_seconds())
    expected_keys = {
        (record.symbol, int(record.time))
        for record in parsed.records
        if int(record.time) >= cutoff
    }
    expected_dates = sorted({candle_time for _, candle_time in expected_keys})

    local_before = _local_keys(Path(db.path), cutoff)
    missing_before = expected_keys - local_before
    missing_dates_before = sorted({candle_time for _, candle_time in missing_before})

    _report(
        progress,
        65,
        f'Đối chiếu xong {len(expected_dates):,} phiên · thiếu {len(missing_before):,} nến '
        f'trong {len(missing_dates_before):,} ngày · đang ghi SQLite, không parse lại ZIP',
    )
    result = _import_parsed_archive(
        db,
        archive_bytes,
        parsed,
        source_url=archive_url,
    )

    _report(progress, 95, 'Ghi SQLite xong · kiểm tra lại dữ liệu sau khi bù')
    local_after = _local_keys(Path(db.path), cutoff)
    missing_after = expected_keys - local_after
    missing_dates_after = sorted({candle_time for _, candle_time in missing_after})

    _report(
        progress,
        100,
        f'Hoàn tất · đã bù {max(0, len(missing_before) - len(missing_after)):,} nến · '
        f'còn thiếu {len(missing_after):,} nến',
    )
    return {
        **result,
        'backfillLookbackDays': lookback_days,
        'backfillFrom': cutoff,
        'backfillTo': latest_time,
        'expectedSessions': len(expected_dates),
        'missingDaysBefore': len(missing_dates_before),
        'missingCandlesBefore': len(missing_before),
        'missingTimesBefore': missing_dates_before,
        'missingDaysAfter': len(missing_dates_after),
        'missingCandlesAfter': len(missing_after),
        'missingTimesAfter': missing_dates_after,
        'backfilledCandles': max(0, len(missing_before) - len(missing_after)),
    }

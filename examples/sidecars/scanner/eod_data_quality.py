from __future__ import annotations

import calendar
import sqlite3
import time
from datetime import date, datetime, time as datetime_time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

PROVIDER_ID = 'vn_eod'
DEFAULT_LOOKBACK_MONTHS = 2
DEFAULT_LIMIT = 40
VN_TZ = ZoneInfo('Asia/Ho_Chi_Minh')
MARKET_CLOSE_HOUR = 16


def _subtract_months(value: date, months: int) -> date:
    month_index = value.year * 12 + value.month - 1 - months
    year, month_zero = divmod(month_index, 12)
    month = month_zero + 1
    day = min(value.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def _latest_completed_session_date(now_dt: datetime) -> date:
    candidate = now_dt.date()
    if candidate.weekday() >= 5 or now_dt.hour < MARKET_CLOSE_HOUR:
        candidate -= timedelta(days=1)
    while candidate.weekday() >= 5:
        candidate -= timedelta(days=1)
    return candidate


def _weekday_sessions(start: date, end: date) -> list[date]:
    if end < start:
        return []
    days = (end - start).days
    return [
        start + timedelta(days=offset)
        for offset in range(days + 1)
        if (start + timedelta(days=offset)).weekday() < 5
    ]


def _midnight_timestamp(value: date) -> int:
    return int(datetime.combine(value, datetime_time.min, tzinfo=VN_TZ).timestamp())


def check_top_volume_coverage(
    db_path: Path,
    *,
    provider: str = PROVIDER_ID,
    lookback_months: int = DEFAULT_LOOKBACK_MONTHS,
    limit: int = DEFAULT_LIMIT,
    now: int | None = None,
) -> dict[str, object]:
    """Check top-volume stocks against every expected weekday session in the last N months.

    The check is independent from candle coverage. Its end date comes from the moment the
    user runs the check: today is included only after 16:00 Vietnam time; otherwise the
    previous weekday is the latest expected completed session.
    """
    if lookback_months <= 0:
        raise ValueError('lookback_months must be positive')
    if limit <= 0:
        raise ValueError('limit must be positive')

    now_ts = int(time.time()) if now is None else int(now)
    now_dt = datetime.fromtimestamp(now_ts, VN_TZ)
    check_date = now_dt.date()
    window_start_date = _subtract_months(check_date, lookback_months)
    window_end_date = _latest_completed_session_date(now_dt)
    expected_dates = _weekday_sessions(window_start_date, window_end_date)
    if not expected_dates:
        raise LookupError('không có phiên giao dịch kỳ vọng trong khoảng kiểm tra')

    expected_times = [_midnight_timestamp(item) for item in expected_dates]
    expected_set = set(expected_times)
    window_start = expected_times[0]
    window_end = expected_times[-1]

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        symbols = [
            dict(row)
            for row in conn.execute(
                '''SELECT i.id AS instrument_id,i.symbol,i.exchange,ms.volume AS latest_volume
                   FROM instruments i
                   JOIN market_snapshot ms ON ms.instrument_id=i.id
                   WHERE i.provider=? AND i.active=1 AND UPPER(COALESCE(i.asset_type,''))='STOCK'
                         AND ms.volume IS NOT NULL
                   ORDER BY ms.volume DESC,i.symbol
                   LIMIT ?''',
                (provider, limit),
            ).fetchall()
        ]
        if not symbols:
            raise LookupError('không tìm thấy cổ phiếu active có volume local')

        ids = [int(item['instrument_id']) for item in symbols]
        placeholders = ','.join('?' for _ in ids)
        rows = conn.execute(
            f'''SELECT instrument_id,time
                FROM candles
                WHERE interval='1d' AND instrument_id IN ({placeholders})
                      AND time>=? AND time<=?
                ORDER BY time,instrument_id''',
            [*ids, window_start, window_end],
        ).fetchall()

        dates_by_id: dict[int, set[int]] = {instrument_id: set() for instrument_id in ids}
        for row in rows:
            instrument_id = int(row['instrument_id'])
            candle_time = int(row['time'])
            if candle_time in expected_set:
                dates_by_id[instrument_id].add(candle_time)

        expected_sessions = len(expected_times)
        results: list[dict[str, object]] = []
        for item in symbols:
            instrument_id = int(item['instrument_id'])
            actual_dates = dates_by_id[instrument_id]
            missing = [candle_time for candle_time in expected_times if candle_time not in actual_dates]
            observed_sessions = expected_sessions - len(missing)
            results.append({
                'symbol': str(item['symbol']),
                'exchange': str(item['exchange'] or ''),
                'latestVolume': float(item['latest_volume']),
                'observedSessions': observed_sessions,
                'expectedSessions': expected_sessions,
                'missingCount': len(missing),
                'missingTimes': missing,
                'status': 'PASS' if not missing else 'MISSING',
            })

        return {
            'provider': provider,
            'checkedAt': now_ts,
            'checkDate': _midnight_timestamp(check_date),
            'fromTime': window_start,
            'toTime': window_end,
            'lookbackMonths': lookback_months,
            'sampleSize': len(symbols),
            'expectedSessions': expected_sessions,
            'calendarRule': 'weekday',
            'allPass': all(int(item['missingCount']) == 0 for item in results),
            'symbols': results,
        }
    finally:
        conn.close()

PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS instruments (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    exchange TEXT NOT NULL DEFAULT '',
    asset_type TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    last_seen_at INTEGER NOT NULL,
    UNIQUE(provider, symbol)
);

CREATE INDEX IF NOT EXISTS idx_instruments_provider_active ON instruments(provider, active, exchange);

CREATE TABLE IF NOT EXISTS market_snapshot (
    instrument_id INTEGER PRIMARY KEY,
    price REAL,
    volume REAL,
    market_cap REAL,
    data_time INTEGER,
    fetched_at INTEGER NOT NULL,
    FOREIGN KEY(instrument_id) REFERENCES instruments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS candles (
    instrument_id INTEGER NOT NULL,
    interval TEXT NOT NULL,
    time INTEGER NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL,
    is_closed INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(instrument_id, interval, time),
    FOREIGN KEY(instrument_id) REFERENCES instruments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_candles_latest ON candles(instrument_id, interval, time DESC);

CREATE TABLE IF NOT EXISTS ha_latest (
    instrument_id INTEGER NOT NULL,
    timeframe TEXT NOT NULL,
    kind TEXT NOT NULL,
    candle_time INTEGER NOT NULL,
    ha_open REAL NOT NULL,
    ha_high REAL NOT NULL,
    ha_low REAL NOT NULL,
    ha_close REAL NOT NULL,
    green INTEGER NOT NULL,
    no_lower_wick INTEGER NOT NULL,
    ha_close_change_pct REAL,
    ha_body_pct REAL,
    algo_version INTEGER NOT NULL,
    source_last_time INTEGER NOT NULL,
    computed_at INTEGER NOT NULL,
    PRIMARY KEY(instrument_id, timeframe, kind),
    FOREIGN KEY(instrument_id) REFERENCES instruments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ha_latest_filter ON ha_latest(timeframe, kind, green, no_lower_wick, ha_close_change_pct);

CREATE TABLE IF NOT EXISTS scan_runs (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    universe_count INTEGER NOT NULL DEFAULT 0,
    stage1_count INTEGER NOT NULL DEFAULT 0,
    history_refresh_count INTEGER NOT NULL DEFAULT 0,
    stage2_count INTEGER NOT NULL DEFAULT 0,
    result_count INTEGER NOT NULL DEFAULT 0,
    filters_json TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT
);

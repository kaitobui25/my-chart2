CREATE TABLE IF NOT EXISTS eod_import_runs (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    source TEXT NOT NULL,
    mode TEXT NOT NULL,
    adjusted INTEGER NOT NULL,
    trade_date INTEGER,
    source_url TEXT,
    source_sha256 TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    member_count INTEGER NOT NULL DEFAULT 0,
    row_count INTEGER NOT NULL DEFAULT 0,
    symbol_count INTEGER NOT NULL DEFAULT 0,
    inserted_candle_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    error TEXT
);

CREATE INDEX IF NOT EXISTS idx_eod_import_provider_status_date
ON eod_import_runs(provider, status, trade_date DESC, finished_at DESC);

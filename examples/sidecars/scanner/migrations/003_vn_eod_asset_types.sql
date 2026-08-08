PRAGMA foreign_keys=ON;

UPDATE instruments
SET asset_type = CASE
    WHEN UPPER(exchange) = 'HOSE'
         AND LENGTH(UPPER(symbol)) = 8
         AND SUBSTR(UPPER(symbol), 1, 1) = 'C'
         AND SUBSTR(UPPER(symbol), 2, 3) NOT GLOB '*[^A-Z0-9]*'
         AND SUBSTR(UPPER(symbol), 5, 4) GLOB '[0-9][0-9][0-9][0-9]'
      THEN 'CW'
    WHEN UPPER(symbol) = 'E1VFVN30'
         OR (SUBSTR(UPPER(symbol), 1, 3) = 'FUE' AND UPPER(symbol) NOT GLOB '*[^A-Z0-9]*')
      THEN 'ETF'
    WHEN SUBSTR(UPPER(symbol), 1, 3) = 'FUC'
         AND UPPER(symbol) NOT GLOB '*[^A-Z0-9]*'
      THEN 'FUND'
    WHEN LENGTH(UPPER(symbol)) = 3
         AND UPPER(symbol) NOT GLOB '*[^A-Z0-9]*'
      THEN 'STOCK'
    ELSE 'UNKNOWN'
END
WHERE provider = 'vn_eod';

-- Existing databases imported before asset classification marked every CafeF row
-- as STOCK. Keep all rows/history, but only fresh STOCK rows participate in the
-- current stock scanner universe.
UPDATE instruments
SET active = 0
WHERE provider = 'vn_eod'
  AND asset_type <> 'STOCK';

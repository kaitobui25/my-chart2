from __future__ import annotations

import re

STOCK = 'STOCK'
ETF = 'ETF'
CW = 'CW'
FUND = 'FUND'
UNKNOWN = 'UNKNOWN'


def classify_vn_security(symbol: str, exchange: str) -> str:
    """Classify CafeF-listed VN securities using audited exchange symbol conventions."""
    normalized_symbol = symbol.strip().upper()
    normalized_exchange = exchange.strip().upper()

    if normalized_exchange == 'HOSE' and re.fullmatch(r'C[A-Z0-9]{3}[0-9]{4}', normalized_symbol):
        return CW
    if normalized_symbol == 'E1VFVN30' or re.fullmatch(r'FUE[A-Z0-9]+', normalized_symbol):
        return ETF
    if re.fullmatch(r'FUC[A-Z0-9]+', normalized_symbol):
        return FUND
    if re.fullmatch(r'[A-Z0-9]{3}', normalized_symbol):
        return STOCK
    return UNKNOWN

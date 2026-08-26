from __future__ import annotations

# CafeF VN EOD stores OHLC prices in thousand VND (kVND).
# Example: 7.61 kVND = 7,610 VND/share.
KVND = 1_000.0


def kvnd_to_vnd(price_kvnd: float) -> float:
    return float(price_kvnd) * KVND

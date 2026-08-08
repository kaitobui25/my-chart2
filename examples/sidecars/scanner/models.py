from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

ProviderId = Literal['fiinquant', 'binance_spot', 'binance_usdm']
Timeframe = Literal['1w', '1M']
CandleKind = Literal['current', 'closed']


@dataclass(frozen=True)
class ProviderCapabilities:
    id: ProviderId
    label: str
    market_cap: bool
    bulk_snapshot: bool
    bulk_history: bool
    universes: tuple[str, ...]
    default_universes: tuple[str, ...]
    timezone: str
    max_history_concurrency: int
    continuous_market: bool
    snapshot_ttl_seconds: int
    history_ttl_seconds: int
    available: bool = True
    detail: str | None = None

    def to_json(self) -> dict[str, Any]:
        payload = asdict(self)
        payload['universes'] = list(self.universes)
        payload['default_universes'] = list(self.default_universes)
        return payload


@dataclass(frozen=True)
class Instrument:
    provider: ProviderId
    symbol: str
    name: str = ''
    exchange: str = ''
    asset_type: str = ''
    active: bool = True


@dataclass(frozen=True)
class MarketSnapshot:
    symbol: str
    price: float | None
    volume: float | None
    market_cap: float | None
    data_time: int | None


@dataclass(frozen=True)
class Candle:
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float | None = None
    is_closed: bool = True


@dataclass(frozen=True)
class ScanFilters:
    price_min: float | None = None
    price_max: float | None = None
    volume_min: float | None = None
    volume_max: float | None = None
    market_cap_min: float | None = None
    market_cap_max: float | None = None


@dataclass(frozen=True)
class HeikinScan:
    timeframe: Timeframe
    green: bool = True
    no_lower_wick: bool = True
    close_change_pct_min: float | None = None
    candle: CandleKind = 'current'


@dataclass(frozen=True)
class ScanRequest:
    source: ProviderId
    universes: tuple[str, ...]
    filters: ScanFilters
    heikin_ashi: HeikinScan

    @staticmethod
    def from_json(payload: Any) -> 'ScanRequest':
        if not isinstance(payload, dict):
            raise ValueError('request body must be a JSON object')
        source = str(payload.get('source') or '').strip()
        if source not in {'fiinquant', 'binance_spot', 'binance_usdm'}:
            raise ValueError(f'unsupported source: {source or "(empty)"}')

        raw_universes = payload.get('universes', [])
        if not isinstance(raw_universes, list):
            raise ValueError('universes must be an array')
        universes = tuple(dict.fromkeys(str(item).strip().upper() for item in raw_universes if str(item).strip()))

        filters_payload = payload.get('filters') or {}
        if not isinstance(filters_payload, dict):
            raise ValueError('filters must be an object')

        def optional_number(key: str) -> float | None:
            value = filters_payload.get(key)
            if value is None or value == '':
                return None
            number = float(value)
            if not (number == number and abs(number) != float('inf')):
                raise ValueError(f'{key} must be finite')
            return number

        filters = ScanFilters(
            price_min=optional_number('priceMin'),
            price_max=optional_number('priceMax'),
            volume_min=optional_number('volumeMin'),
            volume_max=optional_number('volumeMax'),
            market_cap_min=optional_number('marketCapMin'),
            market_cap_max=optional_number('marketCapMax'),
        )

        ha_payload = payload.get('heikinAshi') or {}
        if not isinstance(ha_payload, dict):
            raise ValueError('heikinAshi must be an object')
        timeframe = str(ha_payload.get('timeframe') or '')
        if timeframe not in {'1w', '1M'}:
            raise ValueError('heikinAshi.timeframe must be exactly one of: 1w, 1M')
        candle_kind = str(ha_payload.get('candle') or 'current')
        if candle_kind not in {'current', 'closed'}:
            raise ValueError('heikinAshi.candle must be current or closed')
        close_change = ha_payload.get('closeChangePctMin')
        close_change_pct_min = None if close_change in (None, '') else float(close_change)
        if close_change_pct_min is not None and not (close_change_pct_min == close_change_pct_min and abs(close_change_pct_min) != float('inf')):
            raise ValueError('closeChangePctMin must be finite')
        heikin_ashi = HeikinScan(
            timeframe=timeframe,  # type: ignore[arg-type]
            green=bool(ha_payload.get('green', True)),
            no_lower_wick=bool(ha_payload.get('noLowerWick', True)),
            close_change_pct_min=close_change_pct_min,
            candle=candle_kind,  # type: ignore[arg-type]
        )
        return ScanRequest(source=source, universes=universes, filters=filters, heikin_ashi=heikin_ashi)  # type: ignore[arg-type]

    def to_json(self) -> dict[str, Any]:
        return {
            'source': self.source,
            'universes': list(self.universes),
            'filters': {
                'priceMin': self.filters.price_min,
                'priceMax': self.filters.price_max,
                'volumeMin': self.filters.volume_min,
                'volumeMax': self.filters.volume_max,
                'marketCapMin': self.filters.market_cap_min,
                'marketCapMax': self.filters.market_cap_max,
            },
            'heikinAshi': {
                'timeframe': self.heikin_ashi.timeframe,
                'green': self.heikin_ashi.green,
                'noLowerWick': self.heikin_ashi.no_lower_wick,
                'closeChangePctMin': self.heikin_ashi.close_change_pct_min,
                'candle': self.heikin_ashi.candle,
            },
        }


@dataclass
class ScanResult:
    instrument_id: int
    symbol: str
    name: str
    exchange: str
    price: float | None
    volume: float | None
    market_cap: float | None
    timeframe: Timeframe
    candle_kind: CandleKind
    candle_time: int
    ha_open: float
    ha_high: float
    ha_low: float
    ha_close: float
    green: bool
    no_lower_wick: bool
    ha_close_change_pct: float | None
    ha_body_pct: float | None
    source_last_time: int
    computed_at: int
    stale: bool = False
    warnings: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        payload = asdict(self)
        payload['marketCap'] = payload.pop('market_cap')
        payload['candleKind'] = payload.pop('candle_kind')
        payload['candleTime'] = payload.pop('candle_time')
        payload['haOpen'] = payload.pop('ha_open')
        payload['haHigh'] = payload.pop('ha_high')
        payload['haLow'] = payload.pop('ha_low')
        payload['haClose'] = payload.pop('ha_close')
        payload['noLowerWick'] = payload.pop('no_lower_wick')
        payload['haCloseChangePct'] = payload.pop('ha_close_change_pct')
        payload['haBodyPct'] = payload.pop('ha_body_pct')
        payload['sourceLastTime'] = payload.pop('source_last_time')
        payload['computedAt'] = payload.pop('computed_at')
        payload['instrumentId'] = payload.pop('instrument_id')
        return payload
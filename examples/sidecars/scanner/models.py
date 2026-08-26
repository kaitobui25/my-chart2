from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

ProviderId = Literal['fiinquant', 'vn_eod', 'binance_spot', 'binance_usdm']
Timeframe = Literal['1w', '1M']
CandleKind = Literal['current', 'closed']
RefreshMode = Literal['network', 'preloaded']

VN_STOCK_EXCHANGES = frozenset({'HOSE', 'HNX', 'UPCOM'})


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
    refresh_mode: RefreshMode = 'network'
    available: bool = True
    detail: str | None = None

    @property
    def universes_are_exchanges(self) -> bool:
        return bool(self.universes) and set(self.universes).issubset(VN_STOCK_EXCHANGES)

    def to_json(self) -> dict[str, Any]:
        payload = asdict(self)
        payload['universes'] = list(self.universes)
        payload['default_universes'] = list(self.default_universes)
        payload['universes_are_exchanges'] = self.universes_are_exchanges
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
    enabled: bool | None = None


@dataclass(frozen=True)
class BreakoutVolumeScan:
    enabled: bool = False
    min_median_traded_value: float = 5_000_000_000.0
    min_median_volume: float = 500_000.0
    min_weekly_change_pct: float = 4.0
    min_rvol: float = 1.5
    strong_rvol: float = 2.5


@dataclass(frozen=True)
class ScanRequest:
    source: ProviderId
    universes: tuple[str, ...]
    filters: ScanFilters
    heikin_ashi: HeikinScan
    breakout_volume: BreakoutVolumeScan = BreakoutVolumeScan()

    @property
    def heikin_enabled(self) -> bool:
        """Resolve legacy requests that predate the Scanner 03 toggle.

        Before the explicit `enabled` flag existed, normal requests meant Scanner 03
        and breakout requests meant Scanner 04 only. Preserve that contract while
        allowing new clients to explicitly enable both modes for intersection scans.
        """
        if self.heikin_ashi.enabled is None:
            return not self.breakout_volume.enabled
        return self.heikin_ashi.enabled

    @staticmethod
    def from_json(payload: Any) -> 'ScanRequest':
        if not isinstance(payload, dict):
            raise ValueError('request body must be a JSON object')
        source = str(payload.get('source') or '').strip()
        if source not in {'fiinquant', 'vn_eod', 'binance_spot', 'binance_usdm'}:
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
            enabled=None if 'enabled' not in ha_payload else bool(ha_payload.get('enabled')),
        )

        breakout_payload = payload.get('breakoutVolume') or {}
        if not isinstance(breakout_payload, dict):
            raise ValueError('breakoutVolume must be an object')

        def breakout_number(key: str, default: float) -> float:
            value = breakout_payload.get(key, default)
            number = float(value)
            if not (number == number and abs(number) != float('inf')):
                raise ValueError(f'breakoutVolume.{key} must be finite')
            if number < 0:
                raise ValueError(f'breakoutVolume.{key} must be non-negative')
            return number

        breakout_volume = BreakoutVolumeScan(
            enabled=bool(breakout_payload.get('enabled', False)),
            min_median_traded_value=breakout_number('minMedianTradedValue', 5_000_000_000.0),
            min_median_volume=breakout_number('minMedianVolume', 500_000.0),
            min_weekly_change_pct=breakout_number('minWeeklyChangePct', 4.0),
            min_rvol=breakout_number('minRvol', 1.5),
            strong_rvol=breakout_number('strongRvol', 2.5),
        )
        if breakout_volume.strong_rvol < breakout_volume.min_rvol:
            raise ValueError('breakoutVolume.strongRvol must be >= minRvol')
        if breakout_volume.enabled and source != 'vn_eod':
            raise ValueError('Scanner 04 Breakout + Volume requires source vn_eod')

        request = ScanRequest(
            source=source,  # type: ignore[arg-type]
            universes=universes,
            filters=filters,
            heikin_ashi=heikin_ashi,
            breakout_volume=breakout_volume,
        )
        if not request.heikin_enabled and not request.breakout_volume.enabled:
            raise ValueError('Bật Scanner 03 hoặc Scanner 04 trước khi quét.')
        return request

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
                'enabled': self.heikin_enabled,
                'timeframe': self.heikin_ashi.timeframe,
                'green': self.heikin_ashi.green,
                'noLowerWick': self.heikin_ashi.no_lower_wick,
                'closeChangePctMin': self.heikin_ashi.close_change_pct_min,
                'candle': self.heikin_ashi.candle,
            },
            'breakoutVolume': {
                'enabled': self.breakout_volume.enabled,
                'minMedianTradedValue': self.breakout_volume.min_median_traded_value,
                'minMedianVolume': self.breakout_volume.min_median_volume,
                'minWeeklyChangePct': self.breakout_volume.min_weekly_change_pct,
                'minRvol': self.breakout_volume.min_rvol,
                'strongRvol': self.breakout_volume.strong_rvol,
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

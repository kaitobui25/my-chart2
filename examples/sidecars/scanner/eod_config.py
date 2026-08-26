from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
REPO_ROOT = BASE_DIR.parents[2]
DEFAULT_CONFIG_PATH = REPO_ROOT / 'eod-update.yaml'
DEFAULT_LOOKBACK_DAYS = 90
DEFAULT_TIMEOUT_SECONDS = 300


@dataclass(frozen=True)
class EodUpdateConfig:
    lookback_days: int = DEFAULT_LOOKBACK_DAYS
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS

    def to_json(self) -> dict[str, int]:
        return {
            'lookbackDays': self.lookback_days,
            'timeoutSeconds': self.timeout_seconds,
        }


def _positive_int(raw: str, *, key: str) -> int:
    text = raw.strip().strip('"\'')
    try:
        value = int(text)
    except ValueError as exc:
        raise ValueError(f'{key} must be an integer') from exc
    if value <= 0:
        raise ValueError(f'{key} must be positive')
    return value


def load_eod_update_config(path: Path | None = None) -> EodUpdateConfig:
    """Load the small root YAML config without requiring an extra YAML dependency."""
    config_path = path or Path(os.environ.get('EOD_UPDATE_CONFIG_PATH', str(DEFAULT_CONFIG_PATH)))
    lookback_days = DEFAULT_LOOKBACK_DAYS
    timeout_seconds = DEFAULT_TIMEOUT_SECONDS
    if not config_path.exists():
        return EodUpdateConfig(lookback_days, timeout_seconds)

    in_section = False
    for raw_line in config_path.read_text(encoding='utf-8').splitlines():
        line = raw_line.split('#', 1)[0].rstrip()
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip())
        stripped = line.strip()
        if indent == 0:
            in_section = stripped == 'eod_update:'
            continue
        if not in_section or ':' not in stripped:
            continue
        key, _, raw_value = stripped.partition(':')
        if key == 'lookback_days':
            lookback_days = _positive_int(raw_value, key=key)
        elif key == 'timeout_seconds':
            timeout_seconds = _positive_int(raw_value, key=key)

    if lookback_days > 3650:
        raise ValueError('lookback_days must be <= 3650')
    if timeout_seconds > 3600:
        raise ValueError('timeout_seconds must be <= 3600')
    return EodUpdateConfig(lookback_days, timeout_seconds)

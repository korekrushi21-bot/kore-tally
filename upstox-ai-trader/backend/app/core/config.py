from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_ENV_FILE = Path(__file__).resolve().parents[2] / ".env"  # backend/.env, regardless of cwd


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=_ENV_FILE, env_file_encoding="utf-8", extra="ignore")

    app_env: str = "development"

    upstox_client_id: str
    upstox_client_secret: str
    upstox_redirect_uri: str
    upstox_api_base: str = "https://api.upstox.com"

    database_url: str = "sqlite:///./upstox_trader.db"

    # Fernet key (44-char urlsafe base64). Generate with:
    #   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    token_encryption_key: str

    # Used to sign the OAuth `state` parameter against CSRF. Any long random string.
    session_secret: str

    cors_allow_origins: list[str] = ["http://localhost:8010", "http://localhost:5180"]

    # Paper trading + risk engine defaults — see README for rationale. All
    # overridable per-deployment via env vars; this app enforces whatever is
    # configured here on the backend, not just in UI.
    paper_trading_starting_capital: float = 100_000.0
    risk_max_per_trade_pct: float = 0.005
    risk_max_daily_loss_pct: float = 0.015
    risk_max_open_positions: int = 3
    risk_min_reward_ratio: float = 2.0
    risk_allow_averaging_down: bool = False

    # Approximate cost model for paper P&L only (see app/engine/costs.py).
    cost_brokerage_per_order: float = 20.0
    cost_pct_charges: float = 0.001
    slippage_bps: float = 5.0

    # --- Live trading (real money, real orders) — see app/engine/live_trading.py ---
    # Master kill switch. Defaults to disabled; must be flipped explicitly in .env and
    # the process restarted. There is deliberately no way to enable this via the API.
    live_trading_enabled: bool = False
    # Product type for every live order this app places. "I" = intraday (MIS-equivalent):
    # square-off same day, and the only product exit_all_positions() can flatten via the
    # API (it does not support exiting delivery "D" positions in the equity segment).
    live_order_product: str = "I"
    # Only required if you've registered this app as a SEBI-tracked Algo App on Upstox's
    # developer console; sent as the X-Algo-Name header on every order. Leave unset
    # otherwise — see README for when Upstox requires this.
    upstox_algo_name: str | None = None
    # Blocks a second order on the same instrument within this many seconds, as a guard
    # against accidental double-submission (e.g. a retried request).
    live_duplicate_guard_seconds: int = 10
    # How long (and how many times) to poll Upstox after a MARKET entry order before
    # giving up on confirming its fill. Protective stop-loss/target legs are only placed
    # once the entry is confirmed filled — never against an unconfirmed quantity.
    live_entry_fill_poll_attempts: int = 5
    live_entry_fill_poll_interval_seconds: float = 1.0
    # Exact phrase POST /live/stop-all must receive to execute. This flattens the WHOLE
    # Upstox account (every open order and position, not just ones this app placed), so
    # it's deliberately hard to trigger by accident.
    live_stop_all_confirmation_phrase: str = "STOP ALL LIVE TRADING"


@lru_cache
def get_settings() -> Settings:
    return Settings()

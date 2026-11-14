from pathlib import Path

from app.core.config import _BACKEND_DIR, _pin_relative_sqlite


def test_relative_sqlite_path_is_pinned_to_backend_folder():
    url = _pin_relative_sqlite("sqlite:///./upstox_trader.db")
    assert url == "sqlite:///" + (_BACKEND_DIR / "upstox_trader.db").resolve().as_posix()


def test_memory_absolute_and_postgres_urls_are_untouched():
    assert _pin_relative_sqlite("sqlite:///:memory:") == "sqlite:///:memory:"
    absolute = "sqlite:///" + Path("C:/data/x.db").as_posix()
    assert _pin_relative_sqlite(absolute) == absolute
    pg = "postgresql+psycopg://u:p@db:5432/upstox"
    assert _pin_relative_sqlite(pg) == pg

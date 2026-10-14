from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.routes import auth, backtest, live, market, paper, strategy
from app.core.config import get_settings
from app.db.base import Base, engine


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Dev convenience only. Use Alembic migrations once the schema stabilizes
    # in a later phase.
    Base.metadata.create_all(bind=engine)
    yield


app = FastAPI(title="Upstox AI Smart Trader", version="0.1.0", lifespan=lifespan)

settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allow_origins,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(market.router)
app.include_router(strategy.router)
app.include_router(paper.router)
app.include_router(backtest.router)
app.include_router(live.router)

_static_dir = Path(__file__).resolve().parent / "static"
app.mount("/static", StaticFiles(directory=_static_dir), name="static")


@app.get("/")
def index():
    return {"message": "Upstox AI Smart Trader backend. Open /static/index.html for a manual connect test."}

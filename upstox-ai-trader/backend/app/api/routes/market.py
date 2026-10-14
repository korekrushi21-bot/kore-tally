from fastapi import APIRouter, Depends, HTTPException

from app.api.deps import get_authenticated_client
from app.core.exceptions import UpstoxAPIError
from app.services.upstox_client import UpstoxClient

router = APIRouter(prefix="/market", tags=["market"])


@router.get("/profile")
async def profile(client: UpstoxClient = Depends(get_authenticated_client)):
    return await _call(client.get_profile)


@router.get("/holdings")
async def holdings(client: UpstoxClient = Depends(get_authenticated_client)):
    return await _call(client.get_holdings)


@router.get("/positions")
async def positions(client: UpstoxClient = Depends(get_authenticated_client)):
    return await _call(client.get_positions)


@router.get("/funds")
async def funds(client: UpstoxClient = Depends(get_authenticated_client)):
    return await _call(client.get_funds_and_margin)


@router.get("/orders")
async def orders(client: UpstoxClient = Depends(get_authenticated_client)):
    return await _call(client.get_order_book)


async def _call(fn):
    try:
        return await fn()
    except UpstoxAPIError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc

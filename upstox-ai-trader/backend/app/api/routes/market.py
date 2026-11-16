from fastapi import APIRouter, Depends, HTTPException, Query

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


@router.get("/ltp")
async def ltp(
    instrument_keys: str = Query(..., description="Comma-separated, at most 50"),
    client: UpstoxClient = Depends(get_authenticated_client),
):
    """Last traded prices keyed by our instrument key (e.g. NSE_EQ|INE...)."""
    from app.api.routes.paper import _parse_ltp_response

    keys = [k for k in instrument_keys.split(",") if k][:50]
    if not keys:
        return {"prices": {}}
    try:
        return {"prices": _parse_ltp_response(await client.get_ltp(keys))}
    except UpstoxAPIError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc


async def _call(fn):
    try:
        return await fn()
    except UpstoxAPIError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc

class NotAuthenticatedError(Exception):
    """No broker session exists yet — user has never connected."""


class TokenExpiredError(Exception):
    """Stored token is past its 03:30 IST expiry. Upstox issues no refresh
    tokens, so the only remedy is the user repeating the login flow.
    """


class InvalidStateError(Exception):
    """OAuth `state` parameter missing, expired, or failed signature check."""


class UpstoxAPIError(Exception):
    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        self.message = message
        super().__init__(f"Upstox API error ({status_code}): {message}")

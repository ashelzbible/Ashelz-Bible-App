"""ASGI entrypoint: `uvicorn app.asgi:app`. Fails fast if ENGINE_TOKEN is unset."""

from .main import create_app

app = create_app()

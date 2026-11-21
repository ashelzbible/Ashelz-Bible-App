"""FastAPI wrapper around the deterministic calculation core.

The engine is an internal service: it holds no database credentials and is
reachable only from the API gateway's recalculation worker, which must present
the shared ENGINE_TOKEN. It never logs request bodies (PHI).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
from datetime import date

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from core import ALGORITHM_VERSION
from core.bbt_analyzer import BbtReading
from core.cycle_synthesizer import MucusReading, analyze_cycle
from core.hormone_analyzer import HormoneReading

MAX_ITEMS = 400


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class BbtIn(_Strict):
    day: date
    temp_c: float = Field(allow_inf_nan=False)
    sleep_disrupted: bool = False


class HormoneIn(_Strict):
    day: date
    lh_miu_ml: float | None = Field(default=None, allow_inf_nan=False)
    e3g_ng_ml: float | None = Field(default=None, allow_inf_nan=False)
    pdg_ug_ml: float | None = Field(default=None, allow_inf_nan=False)


class MucusIn(_Strict):
    day: date
    score: int


class AnalyzeRequest(_Strict):
    bbt: list[BbtIn] = Field(default_factory=list, max_length=MAX_ITEMS)
    hormones: list[HormoneIn] = Field(default_factory=list, max_length=MAX_ITEMS)
    mucus: list[MucusIn] = Field(default_factory=list, max_length=MAX_ITEMS)


class DayOut(_Strict):
    day: date
    status: str
    flags: list[str]
    reasoning: list[str]


class AnalyzeResponse(_Strict):
    algorithm_version: str
    input_hash: str
    ovulation_confirmed_on: date | None
    anovulatory_pattern_suspected: bool
    days: list[DayOut]


def input_hash(req: AnalyzeRequest) -> str:
    """Order-independent SHA-256 of the request so identical data dedupes."""
    canonical = {
        "bbt": sorted((r.model_dump(mode="json") for r in req.bbt), key=json.dumps),
        "hormones": sorted((r.model_dump(mode="json") for r in req.hormones), key=json.dumps),
        "mucus": sorted((r.model_dump(mode="json") for r in req.mucus), key=json.dumps),
        "algorithm_version": ALGORITHM_VERSION,
    }
    blob = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()


def create_app(engine_token: str | None = None) -> FastAPI:
    token = engine_token if engine_token is not None else os.environ.get("ENGINE_TOKEN", "")
    if len(token) < 32:
        raise RuntimeError("ENGINE_TOKEN must be set and at least 32 characters")

    app = FastAPI(title="biochem-engine", version=ALGORITHM_VERSION, docs_url=None, redoc_url=None)

    def require_token(x_engine_token: str = Header(default="")) -> None:
        if not hmac.compare_digest(x_engine_token.encode(), token.encode()):
            raise HTTPException(status_code=401, detail="invalid engine token")

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok", "algorithm_version": ALGORITHM_VERSION}

    @app.post("/v1/analyze", response_model=AnalyzeResponse, dependencies=[Depends(require_token)])
    def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
        try:
            result = analyze_cycle(
                [BbtReading(r.day, r.temp_c, r.sleep_disrupted) for r in req.bbt],
                [HormoneReading(r.day, r.lh_miu_ml, r.e3g_ng_ml, r.pdg_ug_ml) for r in req.hormones],
                [MucusReading(r.day, r.score) for r in req.mucus],
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return AnalyzeResponse(
            algorithm_version=ALGORITHM_VERSION,
            input_hash=input_hash(req),
            ovulation_confirmed_on=result.ovulation_confirmed_on,
            anovulatory_pattern_suspected=result.anovulatory_pattern_suspected,
            days=[
                DayOut(
                    day=d.day,
                    status=d.status.value,
                    flags=[f.value for f in d.flags],
                    reasoning=list(d.reasoning),
                )
                for d in result.days
            ],
        )

    return app

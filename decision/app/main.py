"""Decision service.

Scores the candidate grid the policy asks about and explains the top choice.

It returns PROBABILITIES, not decisions. It has no database write access, no
payment credentials and no ability to schedule anything. Everything it says is
advice the TypeScript policy is free to overrule -- and does, whenever a
guardrail applies. That is the whole safety story: the model ranks, the policy
decides, the database enforces.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import lightgbm as lgb
import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel, Field

from .features import FEATURES, to_matrix

MODELS = Path(__file__).resolve().parent.parent / "models"

app = FastAPI(title="rebound decision service", version="1.0.0")

_model: lgb.Booster | None = None
_iso: tuple[np.ndarray, np.ndarray] | None = None
_explainer: Any = None
_metrics: dict = {}


def load_model() -> None:
    global _model, _iso, _metrics
    path = MODELS / "recovery.txt"
    if path.exists():
        _model = lgb.Booster(model_file=str(path))
        if (MODELS / "iso_x.npy").exists():
            _iso = (np.load(MODELS / "iso_x.npy"), np.load(MODELS / "iso_y.npy"))
        if (MODELS / "metrics.json").exists():
            _metrics = json.loads((MODELS / "metrics.json").read_text())


def calibrate(p: np.ndarray) -> np.ndarray:
    """Apply the stored isotonic map. Rebuilt with np.interp rather than
    unpickling a sklearn object, so the artefact stays readable and does not
    break when sklearn's internals change."""
    if _iso is None:
        return p
    x, y = _iso
    return np.interp(p, x, y)


# Cold-start prior, used before the model is trained. Deliberately pessimistic
# and deliberately obvious in the output -- the policy reports which one it
# used, so nobody mistakes an untrained system for a trained one.
PRIOR = {"hard": 0.01, "soft": 0.22, "ambiguous": 0.15}


class ScoreRequest(BaseModel):
    base: dict = Field(..., description="features known at decision time")
    rails: list[str]
    delays: list[int] = Field(..., description="candidate delays in seconds")


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "model_loaded": _model is not None,
        "calibrated": _iso is not None,
        "metrics": _metrics or None,
    }


@app.get("/metrics")
def metrics() -> dict:
    imp = MODELS / "importance.json"
    return {
        "metrics": _metrics or None,
        "importance": json.loads(imp.read_text())[:15] if imp.exists() else [],
    }


@app.post("/score")
def score(req: ScoreRequest) -> dict:
    """Score every (rail, delay) pair. The policy applies the EV maths and the
    guardrails to what comes back."""
    rows = []
    for rail in req.rails:
        for delay in req.delays:
            r = dict(req.base)
            r["candidate_rail"] = rail
            r["delay_hours"] = delay / 3600.0
            rows.append(r)

    if _model is None:
        cls = str(req.base.get("decline_class", "soft"))
        p = PRIOR.get(cls, 0.2)
        grid = [
            {"rail": r["candidate_rail"], "delay": int(r["delay_hours"] * 3600), "p": p}
            for r in rows
        ]
        return {"grid": grid, "shap": [], "source": "prior (model not trained)"}

    X = to_matrix(rows)
    raw = _model.predict(X)
    p = calibrate(np.asarray(raw))

    grid = [
        {
            "rail": rows[i]["candidate_rail"],
            "delay": int(rows[i]["delay_hours"] * 3600),
            "p": round(float(p[i]), 4),
        }
        for i in range(len(rows))
    ]

    best = int(np.argmax(p))
    return {
        "grid": grid,
        "shap": explain_row(X.iloc[[best]]),
        "best": grid[best],
        "source": "lightgbm" + (" + isotonic" if _iso is not None else ""),
    }


def explain_row(X_one) -> list[dict]:
    """Per-feature contribution for one prediction.

    LightGBM's own `pred_contrib` gives exact SHAP values for trees -- no
    sampling, no approximation, and no need to keep a separate explainer alive
    in the request path.
    """
    if _model is None:
        return []
    contrib = _model.predict(X_one, pred_contrib=True)[0]
    names = list(X_one.columns)
    pairs = [
        {"feature": names[i], "contribution": round(float(contrib[i]), 4)}
        for i in range(len(names))
    ]
    pairs.sort(key=lambda d: -abs(d["contribution"]))
    return pairs[:8]


class BatchRequest(BaseModel):
    rows: list[dict] = Field(..., description="fully-formed feature rows, already carrying candidate_rail and delay_hours")


@app.post("/score_batch")
def score_batch(req: BatchRequest) -> dict:
    """Score many rows in one call.

    The counterfactual experiment scores thousands of (order, rail, delay)
    combinations. One HTTP round trip each would dominate the runtime and make
    the comparison too slow to run interactively, which would in practice mean
    nobody runs it. Batching keeps it to one call per simulated round.
    """
    if not req.rows:
        return {"p": [], "source": "empty"}

    if _model is None:
        cls_p = [PRIOR.get(str(r.get("decline_class", "soft")), 0.2) for r in req.rows]
        return {"p": cls_p, "source": "prior (model not trained)"}

    X = to_matrix(req.rows)
    p = calibrate(np.asarray(_model.predict(X)))
    return {
        "p": [round(float(v), 4) for v in p],
        "source": "lightgbm" + (" + isotonic" if _iso is not None else ""),
    }


class ExplainRequest(BaseModel):
    features: dict


@app.post("/explain")
def explain(req: ExplainRequest) -> dict:
    if _model is None:
        return {"shap": [], "note": "model not trained"}
    X = to_matrix([req.features])
    p = float(calibrate(np.asarray(_model.predict(X)))[0])
    return {"p_success": round(p, 4), "shap": explain_row(X)}


@app.post("/reload")
def reload_model() -> dict:
    load_model()
    return {"ok": True, "model_loaded": _model is not None}


load_model()

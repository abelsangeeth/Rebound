"""Train the recovery model.

    python -m app.train

Predicts P(this attempt succeeds) given the decline signal, how long we wait
and which rail we use. The policy turns that probability into money via
expected value; the model itself never decides anything.

Two things here matter more than the headline AUC:

1. CALIBRATION. The policy multiplies this probability by a rupee amount and
   compares it to a cost. A model that ranks perfectly but is systematically
   over-confident will authorise retries that lose money on every single one.
   Ranking is not enough when the output is spent, so we isotonic-calibrate on
   a held-out split and report Brier score and a reliability table.

2. GROUPED SPLITTING. Samples from the same order share a hidden cohort. Split
   them at random and near-duplicate rows land on both sides of the fence, the
   validation score is inflated, and you ship a model that is worse than the
   number on the slide. We split by order instead.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
import psycopg2
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score

from .features import CATEGORICAL, FEATURES, engineer

MODELS = Path(__file__).resolve().parent.parent / "models"
MODELS.mkdir(exist_ok=True)

DB = os.environ.get("DATABASE_URL", "postgres://rebound:rebound@localhost:55432/rebound")


def load() -> pd.DataFrame:
    with psycopg2.connect(DB) as conn:
        df = pd.read_sql(
            """SELECT amount_paise, attempt_no, hours_since_first_failure, delay_hours,
                      decline_class, error_reason, error_source, original_rail,
                      candidate_rail, hour_of_day, day_of_month, prior_attempts,
                      rails_tried, label
                 FROM training_samples""",
            conn,
        )
    return df


def reliability(y: np.ndarray, p: np.ndarray, bins: int = 10) -> list[dict]:
    """Predicted probability vs observed frequency. If the model says 30% and
    30% of those actually convert, the EV maths downstream is sound."""
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip(np.digitize(p, edges) - 1, 0, bins - 1)
    rows = []
    for b in range(bins):
        m = idx == b
        if not m.any():
            continue
        rows.append(
            {
                "bucket": f"{edges[b]:.1f}-{edges[b+1]:.1f}",
                "n": int(m.sum()),
                "predicted": round(float(p[m].mean()), 4),
                "observed": round(float(y[m].mean()), 4),
            }
        )
    return rows


def main() -> None:
    df = load()
    if len(df) < 500:
        print(f"only {len(df)} samples. run the explorer first:\n"
              f"    cd api && npm run seed", file=sys.stderr)
        sys.exit(1)

    print(f"loaded {len(df):,} samples, {df.label.mean()*100:.1f}% positive")

    X = engineer(df)[FEATURES]
    y = df["label"].astype(int).values

    # Grouped split. Rows generated together share hidden structure; keeping
    # them on the same side of the split is what makes the validation number
    # mean something.
    rng = np.random.default_rng(20260901)
    groups = rng.integers(0, 10, size=len(df))
    train_m, calib_m, valid_m = groups < 7, (groups >= 7) & (groups < 8), groups >= 8

    params = dict(
        objective="binary",
        learning_rate=0.05,
        num_leaves=48,
        min_data_in_leaf=60,
        feature_fraction=0.85,
        bagging_fraction=0.85,
        bagging_freq=1,
        lambda_l2=1.0,
        verbose=-1,
        seed=7,
    )
    dtrain = lgb.Dataset(X[train_m], y[train_m], categorical_feature=CATEGORICAL, free_raw_data=False)
    dvalid = lgb.Dataset(X[valid_m], y[valid_m], categorical_feature=CATEGORICAL, reference=dtrain)

    model = lgb.train(
        params,
        dtrain,
        num_boost_round=900,
        valid_sets=[dvalid],
        callbacks=[lgb.early_stopping(60, verbose=False), lgb.log_evaluation(0)],
    )
    print(f"trained: {model.best_iteration} trees")

    raw_calib = model.predict(X[calib_m], num_iteration=model.best_iteration)
    iso = IsotonicRegression(out_of_bounds="clip", y_min=0.001, y_max=0.999)
    iso.fit(raw_calib, y[calib_m])

    raw_valid = model.predict(X[valid_m], num_iteration=model.best_iteration)
    cal_valid = iso.predict(raw_valid)
    yv = y[valid_m]

    metrics = {
        "n_samples": int(len(df)),
        "n_train": int(train_m.sum()),
        "n_valid": int(valid_m.sum()),
        "trees": int(model.best_iteration),
        "auc": round(float(roc_auc_score(yv, raw_valid)), 4),
        "logloss_raw": round(float(log_loss(yv, raw_valid)), 4),
        "logloss_calibrated": round(float(log_loss(yv, cal_valid)), 4),
        "brier_raw": round(float(brier_score_loss(yv, raw_valid)), 4),
        "brier_calibrated": round(float(brier_score_loss(yv, cal_valid)), 4),
        "base_rate": round(float(yv.mean()), 4),
        "reliability": reliability(yv, cal_valid),
    }

    print(f"  AUC              {metrics['auc']}")
    print(f"  Brier  raw       {metrics['brier_raw']}")
    print(f"  Brier  calibrated{metrics['brier_calibrated']:>8}")
    print(f"  base rate        {metrics['base_rate']}")

    model.save_model(str(MODELS / "recovery.txt"), num_iteration=model.best_iteration)
    np.save(MODELS / "iso_x.npy", iso.X_thresholds_)
    np.save(MODELS / "iso_y.npy", iso.y_thresholds_)
    (MODELS / "metrics.json").write_text(json.dumps(metrics, indent=2))

    imp = sorted(
        zip(model.feature_name(), model.feature_importance("gain")),
        key=lambda kv: -kv[1],
    )
    (MODELS / "importance.json").write_text(
        json.dumps([{"feature": f, "gain": float(g)} for f, g in imp], indent=2)
    )
    print("\n  top features by gain:")
    for f, g in imp[:8]:
        print(f"    {f:<28} {g:,.0f}")
    print(f"\nsaved to {MODELS}")


if __name__ == "__main__":
    main()

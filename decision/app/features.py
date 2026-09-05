"""Feature contract.

This module is the single definition of what the model sees. Training and
serving both import it, so the two cannot drift -- training/serving skew is the
most common way a model that scored well offline quietly stops working, and it
is entirely preventable by not writing the transformation twice.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

RAW_NUMERIC = [
    "amount_paise",
    "attempt_no",
    "hours_since_first_failure",
    "delay_hours",
    "hour_of_day",
    "day_of_month",
    "prior_attempts",
    "rails_tried",
]

CATEGORICAL = [
    "decline_class",
    "error_reason",
    "error_source",
    "original_rail",
    "candidate_rail",
]

AFFORDABILITY_RAILS = {"emi", "paylater", "cardless_emi"}

# Every level the model may ever see. Fixing these at training time means an
# unseen category at serving time becomes NaN -- which LightGBM handles -- rather
# than silently shifting every other category's integer code by one.
CATEGORY_LEVELS = {
    "decline_class": ["hard", "soft", "ambiguous"],
    "error_source": ["customer", "business", "bank", "gateway", "issuer", "internal", "network", "unknown"],
    "original_rail": ["upi", "card", "card_token", "netbanking", "wallet", "emi", "paylater"],
    "candidate_rail": ["upi", "card", "card_token", "netbanking", "wallet", "emi", "paylater"],
    "error_reason": [
        "insufficient_funds", "payment_limit_exceeded", "max_amount_exceeded",
        "issuer_down", "gateway_error", "gateway_technical_error", "server_error",
        "authentication_failed", "invalid_otp", "payment_cancelled",
        "card_expired", "card_blocked", "card_disabled", "card_not_supported",
        "incorrect_card_details", "invalid_vpa", "international_transaction_not_allowed",
        "risk_threshold_breached", "do_not_honour", "transaction_not_permitted",
        "upi_collect_expired", "bank_transfer_failed", "payment_timeout",
        "network_error", "payment_pending", "unknown",
    ],
}


def engineer(df: pd.DataFrame) -> pd.DataFrame:
    """Add derived features. Kept deliberately small and interpretable -- each
    one encodes a specific belief about how recovery works, and SHAP output is
    only readable if the features mean something to a human."""
    out = df.copy()

    # Ticket size acts multiplicatively, not additively.
    out["log_amount"] = np.log1p(out["amount_paise"].astype(float) / 100.0)

    # What actually drives a salary-cycle recovery is total elapsed time from
    # the first failure, not the length of this particular wait.
    out["total_wait_hours"] = out["hours_since_first_failure"] + out["delay_hours"]

    # Switching rails is a different action from waiting, and the model needs
    # to be able to say so directly.
    out["rail_switched"] = (out["candidate_rail"] != out["original_rail"]).astype(int)

    # Changing the SHAPE of the ask (split it into instalments) rather than
    # repeating it.
    out["affordability_pivot"] = out["candidate_rail"].isin(AFFORDABILITY_RAILS).astype(int)

    # Salary lands at month end / month start in India. Distance to that
    # boundary is far more useful than the raw day number.
    dom = out["day_of_month"].astype(float)
    out["days_to_month_edge"] = np.minimum(dom - 1.0, 31.0 - dom)

    # Nudges land badly in the small hours; give the model the cyclic structure
    # rather than making it discover that 23 and 0 are adjacent.
    hod = out["hour_of_day"].astype(float)
    out["hour_sin"] = np.sin(2 * np.pi * hod / 24.0)
    out["hour_cos"] = np.cos(2 * np.pi * hod / 24.0)
    out["is_night"] = ((hod >= 1) & (hod <= 6)).astype(int)

    for col, levels in CATEGORY_LEVELS.items():
        if col in out.columns:
            out[col] = pd.Categorical(out[col].astype(str), categories=levels)

    return out


DERIVED = [
    "log_amount",
    "total_wait_hours",
    "rail_switched",
    "affordability_pivot",
    "days_to_month_edge",
    "hour_sin",
    "hour_cos",
    "is_night",
]

FEATURES = RAW_NUMERIC + DERIVED + CATEGORICAL


def to_matrix(records: list[dict]) -> pd.DataFrame:
    """Serving path: raw dicts from the API -> the exact frame the model expects."""
    df = pd.DataFrame(records)
    for col in RAW_NUMERIC:
        if col not in df.columns:
            df[col] = 0
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)
    for col in CATEGORICAL:
        if col not in df.columns:
            df[col] = "unknown"
    return engineer(df)[FEATURES]

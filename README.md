# Rebound

**AI-native payment recovery for Indian merchants.**

About 1 in 8 Indian digital payments fails. Most of those failures are not
fraud and not final — they are a bank that was down for twenty minutes, a
balance that arrives on payday, a limit that the amount happened to cross. The
money is still willing. The plumbing gave up.

Rebound is the layer that decides **whether, when and how** to ask again — and
proves it never charges anyone twice.

---

## The idea in one paragraph

Every payments company retries failed charges. Almost all of them do it with a
fixed schedule: try again in 1 hour, then 6, then 24. That schedule is wrong
for nearly every customer it touches. A bank outage clears in twenty minutes,
so waiting an hour wastes the window. A salary-cycle failure clears in three
days, so retrying at hour one just burns a decline. An expired card never
clears, and every retry against it is money spent to annoy someone. Rebound
learns the timing per failure instead — and refuses to retry at all when the
expected value of the attempt is negative.

---

## What is actually here

| Piece | Stack | What it does |
|---|---|---|
| `api/` | TypeScript · Fastify · Postgres · Redis | Payment state machine, idempotent webhooks, double-entry ledger, retry worker, policy engine |
| `decision/` | Python · LightGBM · FastAPI | Calibrated P(success) per (rail, delay) with SHAP attribution |
| `dashboard/` | React · Vite | Live control surface, invariant panel, chaos console |
| `infra/` | Docker Compose | Postgres 16, Redis 7, schema, invariant views |

About 4,500 lines. Everything runs locally with `docker compose up -d` and
three dev servers. No cloud account needed, no Razorpay account needed.

---

## The two ideas worth your attention

### 1. The simulator is the whole reason this is measurable

We have no production traffic. Rather than pretend otherwise, `sim/gateway.ts`
builds a payment network whose physics we define — six customer cohorts, each
with different recovery behaviour:

| Cohort | Recoverable? | Clears when |
|---|---|---|
| `salary_cycle` | yes | 18–96 h later, on payday |
| `issuer_outage` | yes | 20–300 min later, when the bank is back |
| `limit_exceeded` | yes | never by waiting — only if the *ask changes shape* (EMI) |
| `flaky_network` | yes | ambiguous timeouts; must be reconciled, never retried blind |
| `dead_instrument` | **no** | never — expired or blocked card |
| `impulse_lost` | **no** | never — customer changed their mind |

The cohort is **never visible** to the policy. It has to be inferred from the
decline signal, amount, hour and attempt history.

Two of those cohorts are deliberately confusable. `impulse_lost` emits
`authentication_failed` — the same string a genuinely recoverable payment
emits. A rules engine keyed on the error string treats them identically and
burns retries on the dead one forever. Separating them requires amount, hour
and history, which is precisely what the model is for.

Because ground truth is planted, the dashboard can show a number no production
system can compute:

> **captured ÷ true recoverable ceiling**

A plain "recovery rate" goes up if you simply retry more. This cannot — the
denominator is fixed by what was actually winnable.

### 2. Correctness is enforced by the database, not by carefulness

Retrying payments means the worst bug in the system is charging someone twice.
So the guarantees are structural:

- `UNIQUE (order_id, attempt_no, rail)` — two workers racing on the same retry
  produce one attempt row, and the loser is told so. No distributed lock.
- `UNIQUE (provider_event_id)` on webhooks — a replayed delivery loses the
  insert and is acked `200`. Acking a duplicate with an error would just make
  the provider redeliver it.
- **Ambiguity freezes the order.** A timeout is not a failure. If an attempt is
  `unknown`, no retry may run until reconciliation asks the provider what it
  actually has. This is the single most important rule in the codebase.
- Double-entry ledger — every capture writes balanced legs in one transaction,
  and a Postgres view recomputes the balance continuously.

Seven invariants are recomputed **from the data** on every dashboard poll — not
tracked as counters the app remembers to increment:

```
no_double_capture         no order has two successful attempts
every_group_balances      every ledger entry group sums to zero
ledger_balances_globally  debits equal credits across the whole book
no_retry_while_ambiguous  no attempt follows an unresolved ambiguous one
no_retry_on_hard_decline  no retry after a hard decline
no_orphan_settlement      every ledger entry maps to a real attempt
paid_orders_match_ledger  every paid order has its money posted
```

The **chaos console** in the dashboard lets you attack each one from a button
and reports what the database did about it. Claiming exactly-once is easy;
watching a constraint refuse a real double charge is the part that counts.

---

## Measured results

One run, 426 orders, 398 of which needed recovery. Traffic and ground truth
both from the simulator; the policy sees neither.

```
CAPTURED OF TRUE RECOVERABLE CEILING     84.7%
recovered                                191 orders  (Rs 7,23,865)
true ceiling                             231 orders  (Rs 8,54,518)
wasted retries                           16.8%
ledger                                   208 balanced groups, 0 violations
worker errors                            0
```

By cohort — the policy never sees the cohort label:

| Cohort | Winnable | Needed recovery | Recovered | Rate |
|---|---|---:|---:|---:|
| `salary_cycle` | yes | 102 | 100 | **98.0%** |
| `issuer_outage` | yes | 48 | 46 | **95.8%** |
| `limit_exceeded` | yes | 41 | 39 | **95.1%** |
| `flaky_network` | yes | 40 | 6 | 15.0% |
| `dead_instrument` | **no** | 92 | 0 | 0.0% |
| `impulse_lost` | **no** | 75 | 0 | 0.0% |

The three cleanly-learnable cohorts land at 95–98%. `flaky_network` is the
hardest by construction — half its responses drop, every ambiguous attempt
consumes an attempt slot, and no retry may run until reconciliation resolves
it — so 15% is the honest ceiling-relative number, not a rounding of zero.

The two unrecoverable cohorts sit at exactly 0%, which is the point: **nearly
all remaining waste is `impulse_lost`**, the cohort deliberately built to wear
a soft-looking decline. Hard declines are refused outright — the
`no_retry_on_hard_decline` invariant reports 0 violations across every run.

---

## The counterfactual: does the model earn its place?

Every recovery product claims it beats a fixed schedule. On production traffic
that claim cannot be checked — you only ever observe the arm you actually
played, so you never learn what the other policy would have done with the same
customer.

Here it can be checked. The simulated network is deterministic given a seed, so
the **identical order** — same cohort, same unlock time, same PRNG stream — is
replayed through four policies and the outcomes compared directly.

`POST /api/experiment` (or the button on the dashboard), 2,000 orders:

| Policy | Captured of ceiling | Recovered | Retries | Wasted |
|---|---:|---:|---:|---:|
| Fixed 1h/6h/24h, same rail, retries everything | 49.1% | ₹23,70,786 | 5,244 | 2,155 |
| Rules engine: same schedule, skips hard declines | 47.4% | ₹22,88,478 | 3,411 | 322 |
| Rules engine + rail switch on the last attempt | 49.9% | ₹24,05,312 | 3,411 | 322 |
| **Rebound: model-ranked EV over rail × delay** | **78.6%** | **₹37,92,386** | **1,804** | 322 |

Against the *strongest* baseline — not the weakest — Rebound recovered
**₹13,87,075 more (+57.7%) using 1,607 fewer retries**. More money and fewer
messages, which usually trade off against each other.

Two things make this honest rather than flattering:

- The comparator is chosen at runtime as **whichever rules arm performed best**
  on that seed, so a weak baseline cannot flatter the result.
- All three rules arms already skip hard declines, so every arm shares the same
  322-retry wasted floor. The entire gap above it is **timing and rail choice**,
  with the "don't chase dead cards" insight held constant. Nobody can attribute
  the win to the guardrail.

Where the gap comes from is specific and checkable: a fixed 1h/6h/24h schedule
has spent its last attempt by hour 31, but `salary_cycle` money lands between
18 and 96 hours out — so it misses most of them. And `limit_exceeded` never
clears by waiting at all; it needs the ask to change shape into EMI, which a
fixed schedule has no way to know.

---

## Where the model sits (and where it doesn't)

```
decline signal ─► LightGBM ─► calibrated P(success | rail, delay)
                                        │
                                        ▼
                              policy: EV = p × amount − cost
                                        │
                     ┌──────────────────┴──────────────────┐
                     ▼                                     ▼
              guardrails (hard-coded)              Thompson sampling
              hard decline → never retry           explore rails under
              ambiguous   → reconcile first        uncertainty
              cap 4 attempts, 14-day horizon
```

**The model ranks. The policy decides. The database enforces.**

An LLM (Claude) writes customer-facing copy in English, Hindi and Hinglish, and
explains decisions to merchant ops. It has no path to a debit — it receives a
decision already made and turns it into a sentence. That separation is what
makes it safe to put a language model near a payments system.

### Model results

Trained on 19,163 labelled outcomes generated by a uniformly-random explorer
over the (cohort × rail × delay) grid — the counterfactual coverage production
logs can never contain, because production only ever tries the option the
policy already picked.

```
AUC                 0.932
Brier (calibrated)  0.078
base rate           19.4%

top features by gain
  error_reason         30,953
  total_wait_hours      7,825   ← timing is learned, not fixed
  error_source          7,568
  amount_paise          3,018
  affordability_pivot   2,759   ← switching to EMI is genuinely predictive
  candidate_rail        2,173
  delay_hours           1,993
```

Calibration matters more than AUC here, because the policy **multiplies this
probability by a rupee amount**. A model that ranks perfectly but is
over-confident would authorise retries that lose money on every one. The
reliability table is in the dashboard's model card.

> Honest note: isotonic calibration is roughly neutral on this data (Brier
> 0.0766 raw → 0.0780 calibrated) — LightGBM's log-loss objective is already
> well calibrated here. It is kept as insurance against drift once the
> distribution stops being stationary, not because it improved the number.

---

## Running it

**Prerequisites:** Docker Desktop, Node 20+, Python 3.12.

```
REM Windows. Double-click it, or run it from any directory -- it locates
REM itself, brings up Docker, opens one window per service, and waits until
REM each is actually answering.
start.cmd
```

First run only, to create the Python environment:

```powershell
cd decision
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

<details>
<summary>Starting the four services by hand</summary>

Each is a long-running server that blocks its terminal, so this needs **four
separate terminals** — chaining them in one window means only the first starts.

```powershell
cd infra;     docker compose up -d
cd api;       npm install; npm start                                    # :3000
cd decision;  .\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000
cd dashboard; npm install; npm run dev                                  # :5173
```

Windows PowerShell 5.1 has no `&&` operator — it is a parse error, so use `;`.
The venv interpreter needs backslashes and a leading `.\`; `.venv/Scripts/python`
fails with `'.venv' is not recognized` in both PowerShell and CMD.

macOS / Linux, same four, one per terminal:

```bash
cd infra     && docker compose up -d
cd api       && npm install && npm start
cd decision  && .venv/bin/python -m uvicorn app.main:app --port 8000
cd dashboard && npm install && npm run dev
```

</details>

Then open <http://localhost:5173> and press **Start traffic**.

To retrain the model from scratch:

```bash
cd api && npm run seed              # 19k labelled samples -> Postgres
cd ../decision; .\.venv\Scripts\python.exe -m app.train
```

### Configuration

`.env` is generated on first setup with a locally-random webhook secret, so
**signature verification is a real code path from the first run** rather than
something stubbed out.

| Variable | Needed? | Without it |
|---|---|---|
| `RAZORPAY_WEBHOOK_SECRET` | auto-generated | — |
| `RAZORPAY_KEY_ID` / `_SECRET` | optional | runs on the simulator |
| `ANTHROPIC_API_KEY` | optional | nudges fall back to templates |

Everything works with no external keys at all.

---

## What is real and what is simulated

Being precise about this, because it is the first question worth asking:

**Real:** the state machine, the idempotency constraints, the double-entry
ledger, webhook HMAC verification, the reconciliation protocol, the retry
worker and queue, the policy and its guardrails, the model and its training
pipeline, every invariant check, the chaos console.

**Simulated:** the payment network itself. `sim/gateway.ts` stands in for
Razorpay. It emits real Razorpay error codes (`insufficient_funds`,
`issuer_down`, `payment_limit_exceeded`, …) through the same interface the
live adapter implements, so swapping in `razorpay.ts` is a one-line change
in `runAttempt`.

The simulation is not a shortcut around missing data — it is what makes the
central claim *measurable*. Against live traffic you can report a recovery
rate. Only against planted ground truth can you report what fraction of the
genuinely recoverable money you actually captured, which is the only number
that says whether the policy is any good.

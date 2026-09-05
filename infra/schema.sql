-- Rebound: AI Revenue Recovery
-- All money is BIGINT paise. Never floats. Never NUMERIC-with-rounding-surprises.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- orders: a merchant's intent to collect a specific amount from a customer.
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  id                TEXT PRIMARY KEY,
  merchant_id       TEXT NOT NULL,
  customer_id       TEXT NOT NULL,
  amount_paise      BIGINT NOT NULL CHECK (amount_paise > 0),
  currency          TEXT NOT NULL DEFAULT 'INR',
  status            TEXT NOT NULL DEFAULT 'created'
                    CHECK (status IN ('created','paid','recovering','abandoned','refunded')),
  -- ground truth from the simulator; NULL for real Razorpay traffic.
  -- Lets us measure how close the policy gets to the achievable ceiling.
  sim_recoverable   BOOLEAN,
  sim_cohort        TEXT,
  sim_state         JSONB,
  original_rail     TEXT,
  first_failed_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at           TIMESTAMPTZ
);
CREATE INDEX orders_status_idx  ON orders (status);
CREATE INDEX orders_created_idx ON orders (created_at DESC);

-- ---------------------------------------------------------------------------
-- payment_attempts: one row per try. This table is the idempotency anchor.
-- The UNIQUE constraint is the actual guarantee -- not application logic,
-- not a Redis lock, not a mutex. The database refuses the double charge.
-- ---------------------------------------------------------------------------
CREATE TABLE payment_attempts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  attempt_no          INT  NOT NULL CHECK (attempt_no >= 1),
  rail                TEXT NOT NULL,
  amount_paise        BIGINT NOT NULL CHECK (amount_paise > 0),
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','succeeded','failed','unknown')),
  provider_payment_id TEXT,
  error_code          TEXT,
  error_source        TEXT,
  error_step          TEXT,
  error_reason        TEXT,
  error_description   TEXT,
  -- hard = never retry, soft = retry pays off, ambiguous = MUST reconcile first
  decline_class       TEXT CHECK (decline_class IN ('hard','soft','ambiguous')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at         TIMESTAMPTZ,
  CONSTRAINT payment_attempts_idem UNIQUE (order_id, attempt_no, rail)
);
CREATE INDEX pa_order_idx  ON payment_attempts (order_id, attempt_no);
CREATE INDEX pa_status_idx ON payment_attempts (status) WHERE status IN ('pending','unknown');

-- ---------------------------------------------------------------------------
-- decisions: every call the policy made, and why. Audit trail for the money
-- path -- a merchant must be able to ask "why did you retry that?"
-- ---------------------------------------------------------------------------
CREATE TABLE decisions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  after_attempt  INT NOT NULL,
  should_retry   BOOLEAN NOT NULL,
  delay_seconds  INT,
  rail           TEXT,
  p_success      REAL,
  ev_paise       BIGINT,
  policy         TEXT NOT NULL,
  reasons        JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX decisions_order_idx ON decisions (order_id, created_at);

-- ---------------------------------------------------------------------------
-- ledger_entries: append-only, double-entry. No UPDATE, no DELETE, ever.
-- Every movement of money writes >= 2 rows sharing an entry_group, and the
-- debits must equal the credits within that group. A correction is a new
-- reversing group, never an edit.
-- ---------------------------------------------------------------------------
CREATE TABLE ledger_entries (
  id           BIGSERIAL PRIMARY KEY,
  entry_group  UUID NOT NULL,
  order_id     TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  account      TEXT NOT NULL,
  direction    TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  ref_type     TEXT NOT NULL,
  ref_id       TEXT,
  memo         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_group_idx ON ledger_entries (entry_group);
CREATE INDEX ledger_order_idx ON ledger_entries (order_id);
-- one settlement per (order, attempt): a replayed webhook cannot double-post
CREATE UNIQUE INDEX ledger_settlement_once
  ON ledger_entries (ref_type, ref_id, account, direction)
  WHERE ref_type = 'attempt';

REVOKE UPDATE, DELETE ON ledger_entries FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- webhook_events: at-least-once delivery in, exactly-once effects out.
-- Dedupe key is the provider's event id. Replays hit the unique index and
-- are acknowledged without re-running side effects.
-- ---------------------------------------------------------------------------
CREATE TABLE webhook_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_event_id TEXT NOT NULL UNIQUE,
  event_type        TEXT NOT NULL,
  signature_ok      BOOLEAN NOT NULL,
  payload           JSONB NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at      TIMESTAMPTZ,
  duplicate_of      TEXT
);
CREATE INDEX we_type_idx ON webhook_events (event_type, received_at DESC);

-- ---------------------------------------------------------------------------
-- rail_health: rolling success counts per rail. Feeds both the Wilson lower
-- bound used for routing and the circuit breaker. Beta posterior for the
-- Thompson sampler lives here too (alpha = successes+1, beta = failures+1).
-- ---------------------------------------------------------------------------
CREATE TABLE rail_health (
  rail          TEXT NOT NULL,
  bucket        TIMESTAMPTZ NOT NULL,
  attempts      INT NOT NULL DEFAULT 0,
  successes     INT NOT NULL DEFAULT 0,
  issuer_errors INT NOT NULL DEFAULT 0,
  PRIMARY KEY (rail, bucket)
);

-- ---------------------------------------------------------------------------
-- nudges: LLM-written customer messages. Note there is no column here that
-- can move money. The model writes copy; the policy decides payments.
-- ---------------------------------------------------------------------------
CREATE TABLE nudges (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL,
  language    TEXT NOT NULL,
  body        TEXT NOT NULL,
  generator   TEXT NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chaos_events (
  id         BIGSERIAL PRIMARY KEY,
  kind       TEXT NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- invariants: the properties that must hold no matter what the chaos console
-- throws at the system. The dashboard polls this view directly, so the panel
-- is reading the real database, not a number the API remembered to update.
-- ---------------------------------------------------------------------------
CREATE VIEW invariants AS
  SELECT
    'ledger_balances_globally' AS name,
    'Total debits equal total credits' AS statement,
    COALESCE(SUM(CASE WHEN direction='debit' THEN amount_paise ELSE -amount_paise END),0) = 0 AS ok,
    COALESCE(SUM(CASE WHEN direction='debit' THEN amount_paise ELSE -amount_paise END),0)::TEXT AS observed
  FROM ledger_entries

  UNION ALL
  SELECT
    'every_group_balances',
    'Each double-entry group nets to zero',
    COUNT(*) = 0,
    COUNT(*)::TEXT
  FROM (
    SELECT entry_group
    FROM ledger_entries
    GROUP BY entry_group
    HAVING SUM(CASE WHEN direction='debit' THEN amount_paise ELSE -amount_paise END) <> 0
  ) unbalanced

  UNION ALL
  SELECT
    'no_double_capture',
    'No order has more than one successful attempt',
    COUNT(*) = 0,
    COUNT(*)::TEXT
  FROM (
    SELECT order_id FROM payment_attempts
    WHERE status='succeeded'
    GROUP BY order_id HAVING COUNT(*) > 1
  ) dbl

  UNION ALL
  SELECT
    'no_orphan_settlement',
    'Every captured payment posted to the ledger',
    COUNT(*) = 0,
    COUNT(*)::TEXT
  FROM payment_attempts pa
  WHERE pa.status='succeeded'
    AND NOT EXISTS (
      SELECT 1 FROM ledger_entries le
      WHERE le.ref_type='attempt' AND le.ref_id = pa.id::TEXT
    )

  UNION ALL
  SELECT
    'paid_orders_match_ledger',
    'Merchant payable equals the order amount for every paid order',
    COUNT(*) = 0,
    COUNT(*)::TEXT
  FROM (
    SELECT o.id
    FROM orders o
    JOIN ledger_entries le ON le.order_id = o.id
                          AND le.account='merchant_payable'
                          AND le.direction='credit'
    WHERE o.status='paid'
    GROUP BY o.id, o.amount_paise
    HAVING SUM(le.amount_paise) <> o.amount_paise
  ) mismatch

  UNION ALL
  SELECT
    'no_retry_on_hard_decline',
    'A hard decline is never retried',
    COUNT(*) = 0,
    COUNT(*)::TEXT
  FROM payment_attempts a
  JOIN payment_attempts b
    ON b.order_id = a.order_id AND b.attempt_no > a.attempt_no
  WHERE a.decline_class = 'hard'

  UNION ALL
  SELECT
    'no_retry_while_ambiguous',
    'Nothing is retried while a prior attempt is still unresolved',
    COUNT(*) = 0,
    COUNT(*)::TEXT
  FROM payment_attempts a
  JOIN payment_attempts b
    ON b.order_id = a.order_id AND b.attempt_no > a.attempt_no
  WHERE a.status = 'unknown' AND b.created_at < COALESCE(a.resolved_at, 'infinity'::timestamptz);
-- Labelled outcomes for the model.
--
-- Written by the TypeScript explorer, which runs the same simulated network
-- the live system runs. Keeping one implementation of the physics means the
-- model cannot be accidentally trained on a world that differs from the one
-- it is later scored in -- a subtle and very common way to get a model that
-- looks excellent offline and is useless online.
CREATE TABLE IF NOT EXISTS training_samples (
  id                        BIGSERIAL PRIMARY KEY,
  amount_paise              BIGINT  NOT NULL,
  attempt_no                INT     NOT NULL,
  hours_since_first_failure REAL    NOT NULL,
  delay_hours               REAL    NOT NULL,
  decline_class             TEXT    NOT NULL,
  error_reason              TEXT    NOT NULL,
  error_source              TEXT    NOT NULL,
  original_rail             TEXT    NOT NULL,
  candidate_rail            TEXT    NOT NULL,
  hour_of_day               INT     NOT NULL,
  day_of_month              INT     NOT NULL,
  prior_attempts            INT     NOT NULL,
  rails_tried               INT     NOT NULL,
  label                     INT     NOT NULL CHECK (label IN (0,1)),
  source                    TEXT    NOT NULL DEFAULT 'explorer',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ts_source_idx ON training_samples (source, created_at DESC);

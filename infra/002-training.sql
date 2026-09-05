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

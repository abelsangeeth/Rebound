import type { DeclineClass } from './taxonomy.js';
import type { SimState } from '../sim/gateway.js';
import { HOUR } from '../sim/clock.js';

export interface OrderRow {
  id: string;
  merchant_id: string;
  customer_id: string;
  amount_paise: number;
  status: string;
  sim_recoverable: boolean | null;
  sim_cohort: string | null;
  sim_state: SimState | null;
  original_rail: string | null;
  first_failed_at: Date | null;
  created_at: Date;
}

export interface AttemptRow {
  id: string;
  order_id: string;
  attempt_no: number;
  rail: string;
  amount_paise: number;
  status: 'pending' | 'succeeded' | 'failed' | 'unknown';
  error_reason: string | null;
  error_source: string | null;
  error_step: string | null;
  error_code: string | null;
  decline_class: DeclineClass | null;
  created_at: Date;
}

/** Features handed to the model. Everything here is knowable at decision
 *  time -- no cohort, no ground truth, no leakage. */
export interface Features {
  amount_paise: number;
  attempt_no: number;
  hours_since_first_failure: number;
  decline_class: DeclineClass;
  error_reason: string;
  error_source: string;
  original_rail: string;
  candidate_rail: string;
  hour_of_day: number;
  day_of_month: number;
  prior_attempts: number;
  rails_tried: number;
}

export function buildFeatures(
  order: OrderRow,
  last: AttemptRow,
  candidateRail: string,
  priorAttempts: number,
  railsTried: number,
  atMs: number,
): Features {
  const firstFailed = order.first_failed_at ? order.first_failed_at.getTime() : atMs;
  const d = new Date(atMs);
  return {
    amount_paise: order.amount_paise,
    attempt_no: last.attempt_no,
    hours_since_first_failure: Math.max(0, (atMs - firstFailed) / HOUR),
    decline_class: last.decline_class ?? 'ambiguous',
    error_reason: last.error_reason ?? 'unknown',
    error_source: last.error_source ?? 'unknown',
    original_rail: order.original_rail ?? last.rail,
    candidate_rail: candidateRail,
    hour_of_day: d.getUTCHours(),
    day_of_month: d.getUTCDate(),
    prior_attempts: priorAttempts,
    rails_tried: railsTried,
  };
}


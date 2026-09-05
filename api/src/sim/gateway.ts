import { clock, HOUR, MINUTE } from './clock.js';

// ---------------------------------------------------------------------------
// Simulated payment network with PLANTED GROUND TRUTH.
//
// We have no production traffic, so we build a world whose physics we know
// exactly. That turns the missing-data problem into an advantage: because the
// true recovery ceiling is known, the dashboard can show how much of the
// achievable money the policy actually captured -- a number you cannot compute
// on real traffic, ever.
//
// Six cohorts, each with different recovery physics. Crucially the cohort is
// NOT observable at decision time. The model has to infer it from the decline
// signal, amount, hour and attempt history. Two cohorts are deliberately
// confusable from the error reason alone, which is exactly what makes this a
// learning problem rather than a lookup table.
// ---------------------------------------------------------------------------

export type Cohort =
  | 'salary_cycle'
  | 'issuer_outage'
  | 'limit_exceeded'
  | 'dead_instrument'
  | 'flaky_network'
  | 'impulse_lost';

export const COHORTS: Cohort[] = [
  'salary_cycle',
  'issuer_outage',
  'limit_exceeded',
  'dead_instrument',
  'flaky_network',
  'impulse_lost',
];

/** Population mix. Roughly mirrors published Indian card/UPI decline splits. */
const COHORT_WEIGHTS: Record<Cohort, number> = {
  salary_cycle: 0.26,
  issuer_outage: 0.14,
  limit_exceeded: 0.12,
  dead_instrument: 0.18,
  flaky_network: 0.10,
  impulse_lost: 0.20,
};

/** Which cohorts can ever be recovered. The ceiling is the value of these. */
export const RECOVERABLE: Record<Cohort, boolean> = {
  salary_cycle: true,
  issuer_outage: true,
  limit_exceeded: true,
  flaky_network: true,
  dead_instrument: false,
  impulse_lost: false,
};

// Deterministic PRNG so a demo run can be reproduced exactly.
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimState {
  cohort: Cohort;
  /** virtual ms after the first failure at which money becomes available */
  unlockAt: number;
  /** for flaky_network: whether the issuer really took the money on a timeout */
  ghostCharged: boolean;
  seed: number;
}

export interface AttemptOutcome {
  status: 'succeeded' | 'failed' | 'unknown';
  provider_payment_id?: string;
  error_code?: string;
  error_reason?: string;
  error_source?: string;
  error_step?: string;
  error_description?: string;
  /** simulator-only: what REALLY happened at the issuer, hidden from the app */
  truth?: 'captured' | 'not_captured';
  /** simulator-only: the decline underneath a dropped response. Readable only
   *  by reconciliation, never by the policy at decision time. */
  underlying?: {
    error_code?: string;
    error_reason?: string;
    error_source?: string;
    error_step?: string;
  };
}

export function pickCohort(rnd: () => number): Cohort {
  const r = rnd();
  let acc = 0;
  for (const c of COHORTS) {
    acc += COHORT_WEIGHTS[c];
    if (r <= acc) return c;
  }
  return 'impulse_lost';
}

export function newSimState(rnd: () => number): SimState {
  const cohort = pickCohort(rnd);
  let unlockAt = 0;
  switch (cohort) {
    // Money lands on payday. Somewhere between three-quarters of a day and
    // four days out -- the exact wait is what the model has to estimate.
    case 'salary_cycle':
      unlockAt = (18 + rnd() * 78) * HOUR;
      break;
    // Bank outages are short. Retrying in two hours beats retrying in two days,
    // which is the exact opposite of the salary cohort. A fixed retry schedule
    // cannot be right for both.
    case 'issuer_outage':
      unlockAt = (20 + rnd() * 280) * MINUTE;
      break;
    // Never unlocks by waiting. Only a different ask converts it.
    case 'limit_exceeded':
      unlockAt = Number.POSITIVE_INFINITY;
      break;
    case 'flaky_network':
      unlockAt = rnd() * 4 * HOUR;
      break;
    default:
      unlockAt = Number.POSITIVE_INFINITY;
  }
  return {
    cohort,
    unlockAt,
    ghostCharged: false,
    seed: Math.floor(rnd() * 2 ** 31),
  };
}

/** The decline signal the cohort produces on its first failure. */
export function firstFailure(cohort: Cohort, rnd: () => number): AttemptOutcome {
  const mk = (reason: string, source: string, step: string, code = 'BAD_REQUEST_ERROR') => ({
    status: 'failed' as const,
    error_code: code,
    error_reason: reason,
    error_source: source,
    error_step: step,
    error_description: reason.replace(/_/g, ' '),
    truth: 'not_captured' as const,
  });
  switch (cohort) {
    case 'salary_cycle':
      return mk('insufficient_funds', 'issuer', 'payment_authorization', 'GATEWAY_ERROR');
    case 'issuer_outage':
      return rnd() < 0.6
        ? mk('issuer_down', 'bank', 'payment_authorization', 'GATEWAY_ERROR')
        : mk('gateway_error', 'gateway', 'payment_authorization', 'GATEWAY_ERROR');
    case 'limit_exceeded':
      return rnd() < 0.5
        ? mk('payment_limit_exceeded', 'issuer', 'payment_authorization')
        : mk('max_amount_exceeded', 'issuer', 'payment_authorization');
    case 'dead_instrument': {
      const r = rnd();
      if (r < 0.4) return mk('card_expired', 'customer', 'payment_initiation');
      if (r < 0.7) return mk('card_blocked', 'issuer', 'payment_authorization');
      return mk('invalid_vpa', 'customer', 'payment_initiation');
    }
    case 'flaky_network':
      return {
        status: 'unknown',
        error_code: 'GATEWAY_ERROR',
        error_reason: 'payment_timeout',
        error_source: 'network',
        error_step: 'payment_response',
        error_description: 'payment timeout',
        truth: 'not_captured',
      };
    case 'impulse_lost':
      // Deliberately wears a soft-looking mask. `authentication_failed` also
      // appears on genuinely recoverable payments, so a rules engine keyed on
      // the reason string will burn retries here forever. Separating the two
      // needs amount, hour and history -- i.e. it needs the model.
      return rnd() < 0.5
        ? mk('authentication_failed', 'customer', 'payment_authentication')
        : mk('payment_cancelled', 'customer', 'payment_authentication');
  }
}

const AFFORDABILITY_RAILS = new Set(['emi', 'paylater', 'cardless_emi']);

/**
 * True probability that an attempt succeeds. The policy never sees this --
 * it is the answer key. The dashboard uses it to compute the ceiling.
 */
export function trueSuccessProb(
  st: SimState,
  rail: string,
  originalRail: string,
  elapsed: number,
  amountPaise: number,
  atMs: number,
): number {
  const switched = rail !== originalRail;
  // Any rail switch costs a little: the customer has to complete an unfamiliar
  // flow. Small, but enough that switching for no reason is a losing move.
  const friction = switched ? 0.92 : 1;

  // Nudges land badly in the small hours regardless of cohort.
  const hour = new Date(atMs).getUTCHours();
  const tod = hour >= 1 && hour <= 6 ? 0.72 : 1;

  // Larger tickets convert worse on retry across the board.
  const size = amountPaise > 5_000_00 ? 0.85 : amountPaise > 1_500_00 ? 0.95 : 1;

  let base: number;
  switch (st.cohort) {
    case 'dead_instrument':
      return 0.004; // the instrument is gone; no schedule and no rail fixes it

    case 'impulse_lost':
      // Decays toward zero. Looks soft, never converts.
      base = 0.045 * Math.exp(-elapsed / (40 * HOUR));
      break;

    case 'salary_cycle':
      base = elapsed >= st.unlockAt ? 0.84 : 0.05;
      break;

    case 'issuer_outage':
      if (elapsed >= st.unlockAt) base = 0.88;
      // The outage is issuer-specific, so moving off the affected rail works
      // even while it lasts. Waiting also works. Doing neither does not.
      else base = switched ? 0.58 : 0.03;
      break;

    case 'limit_exceeded':
      if (AFFORDABILITY_RAILS.has(rail)) base = 0.74; // split the ask, it clears
      else if (rail === 'upi') base = 0.38; // different limit regime
      else base = 0.04; // same card, same amount, same wall
      break;

    case 'flaky_network':
      base = elapsed >= st.unlockAt ? 0.80 : 0.45;
      break;
  }

  return Math.max(0, Math.min(1, base * friction * tod * size));
}

/**
 * Run one attempt against the simulated network.
 *
 * `onGhostCharge` fires when the network really took the customer's money but
 * returned a timeout. That is the trap: the app is told nothing conclusive,
 * and if it retries without reconciling first, the customer pays twice.
 */
export function attempt(
  st: SimState,
  rail: string,
  originalRail: string,
  elapsed: number,
  amountPaise: number,
  rnd: () => number,
  atMs = clock.now(),
): AttemptOutcome {
  const p = trueSuccessProb(st, rail, originalRail, elapsed, amountPaise, atMs);
  const won = rnd() < p;

  // Timeouts are not a cohort property -- any rail can drop a response. The
  // flaky cohort just does it far more often.
  const timeoutRate = st.cohort === 'flaky_network' ? 0.5 : 0.035;
  if (rnd() < timeoutRate) {
    if (won) st.ghostCharged = true;
    // What the issuer really saw underneath the dropped response. The app
    // cannot see this at attempt time -- that is the whole point of an
    // ambiguous outcome -- but the provider can report it on reconciliation,
    // which is how the true decline class is eventually recovered.
    const under = won ? undefined : firstFailure(st.cohort, rnd);
    return {
      status: 'unknown',
      provider_payment_id: won ? `pay_sim_${Math.floor(rnd() * 1e12).toString(36)}` : undefined,
      error_code: 'GATEWAY_ERROR',
      error_reason: 'payment_timeout',
      error_source: 'network',
      error_step: 'payment_response',
      error_description: 'no response from upstream within the deadline',
      truth: won ? 'captured' : 'not_captured',
      underlying: under && {
        error_code: under.error_code,
        error_reason: under.error_reason,
        error_source: under.error_source,
        error_step: under.error_step,
      },
    };
  }

  if (won) {
    return {
      status: 'succeeded',
      provider_payment_id: `pay_sim_${Math.floor(rnd() * 1e12).toString(36)}`,
      truth: 'captured',
    };
  }
  return { ...firstFailure(st.cohort, rnd), truth: 'not_captured' };
}

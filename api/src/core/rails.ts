import { q } from './db.js';
import { clock, HOUR } from '../sim/clock.js';

// Rail routing.
//
// Three separate jobs that are often conflated:
//   1. Score a rail honestly when the sample is small  -> Wilson lower bound
//   2. Stop sending traffic into an outage             -> circuit breaker
//   3. Keep learning without giving up revenue         -> Thompson sampling
//
// The breaker only counts ISSUER-side errors. A rail with a hundred
// `insufficient_funds` declines is working perfectly; a rail with twenty
// `issuer_down` errors is not. Conflating them takes a healthy rail offline
// during a payday crunch, which is precisely when you need it.

const WINDOW_HOURS = 6;

const bucketOf = (ms: number) => new Date(Math.floor(ms / HOUR) * HOUR);

export async function recordRailOutcome(rail: string, success: boolean, issuerSide: boolean) {
  await q(
    `INSERT INTO rail_health (rail, bucket, attempts, successes, issuer_errors)
     VALUES ($1,$2,1,$3,$4)
     ON CONFLICT (rail, bucket) DO UPDATE
       SET attempts = rail_health.attempts + 1,
           successes = rail_health.successes + EXCLUDED.successes,
           issuer_errors = rail_health.issuer_errors + EXCLUDED.issuer_errors`,
    [rail, bucketOf(clock.now()), success ? 1 : 0, !success && issuerSide ? 1 : 0],
  );
}

export interface RailScore {
  rail: string;
  attempts: number;
  successes: number;
  issuer_errors: number;
  rate: number;
  wilson: number;
  breaker_open: boolean;
}

/**
 * Wilson score interval, lower bound at 95%.
 *
 * A rail that is 1-for-1 has a naive rate of 100% and would win every routing
 * decision forever on a single lucky sample. Wilson pulls small samples toward
 * the middle in proportion to how little we know, so a rail has to actually
 * earn its ranking.
 */
export function wilsonLower(successes: number, attempts: number, z = 1.96): number {
  if (attempts === 0) return 0;
  const p = successes / attempts;
  const z2 = z * z;
  const denom = 1 + z2 / attempts;
  const centre = p + z2 / (2 * attempts);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * attempts)) / attempts);
  return Math.max(0, (centre - margin) / denom);
}

export async function railScores(): Promise<RailScore[]> {
  const since = new Date(clock.now() - WINDOW_HOURS * HOUR);
  const rows = await q<{
    rail: string;
    attempts: number;
    successes: number;
    issuer_errors: number;
  }>(
    `SELECT rail,
            SUM(attempts)::int      AS attempts,
            SUM(successes)::int     AS successes,
            SUM(issuer_errors)::int AS issuer_errors
       FROM rail_health WHERE bucket >= $1
      GROUP BY rail`,
    [since],
  );
  return rows.map((r) => ({
    ...r,
    rate: r.attempts ? r.successes / r.attempts : 0,
    wilson: wilsonLower(r.successes, r.attempts),
    // Enough evidence, and most of the damage is the bank's fault, not the
    // customer's.
    breaker_open: r.attempts >= 12 && r.issuer_errors / r.attempts >= 0.4,
  }));
}

// --- Thompson sampling -----------------------------------------------------
// Beta posterior per rail. Sampling from it rather than taking the mean is
// what buys exploration: a rail we know little about has a wide posterior and
// will occasionally sample high enough to get picked, which is how it earns
// the evidence to be judged properly. No epsilon to hand-tune.

function gammaSample(k: number, rnd: () => number): number {
  if (k < 1) return gammaSample(k + 1, rnd) * Math.pow(rnd(), 1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do {
      const u1 = rnd() || 1e-9;
      const u2 = rnd() || 1e-9;
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rnd() || 1e-9;
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function betaSample(alpha: number, beta: number, rnd: () => number): number {
  const x = gammaSample(alpha, rnd);
  const y = gammaSample(beta, rnd);
  return x / (x + y);
}

/** Pick a rail by sampling each posterior once and taking the argmax. */
export function thompsonPick(
  scores: RailScore[],
  candidates: string[],
  rnd: () => number,
): { rail: string; sampled: Record<string, number> } {
  const byRail = new Map(scores.map((s) => [s.rail, s]));
  const sampled: Record<string, number> = {};
  let best = candidates[0];
  let bestVal = -1;
  for (const rail of candidates) {
    const s = byRail.get(rail);
    if (s?.breaker_open) {
      sampled[rail] = 0;
      continue;
    }
    const a = (s?.successes ?? 0) + 1;
    const b = (s?.attempts ?? 0) - (s?.successes ?? 0) + 1;
    const v = betaSample(a, b, rnd);
    sampled[rail] = Number(v.toFixed(4));
    if (v > bestVal) {
      bestVal = v;
      best = rail;
    }
  }
  return { rail: best, sampled };
}

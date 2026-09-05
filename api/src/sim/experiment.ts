/**
 * Counterfactual A/B.
 *
 * The claim this project makes is "learning the timing beats a fixed
 * schedule". On production traffic that claim is unfalsifiable: you only ever
 * observe the arm you actually played, so you never learn what the other
 * policy would have recovered on the same customer.
 *
 * Here we can. The simulated network is deterministic given a seed, so the
 * SAME order -- same cohort, same unlock time, same physics, same PRNG stream
 * -- can be replayed through several policies and the outcomes compared
 * directly. That is a genuine counterfactual, not a before/after on different
 * traffic, and it is the strongest thing the simulator buys us.
 *
 * Three arms:
 *
 *   naive_fixed    retry at 1h / 6h / 24h on the original rail, always.
 *                  What most recovery in production actually does.
 *   rules_guarded  the same schedule, but skips hard declines. A competent
 *                  rules engine. Isolating this arm matters: the gap between
 *                  it and Rebound is purely timing and rail choice, with the
 *                  "don't chase dead cards" insight held constant, so nobody
 *                  can attribute the win to the guardrail alone.
 *   rebound        model-ranked EV over the full (rail, delay) grid.
 *
 * Everything runs in memory. It touches no tables and pollutes no metrics.
 */
import { env } from '../core/env.js';
import { classify } from '../core/taxonomy.js';
import { feeFor } from '../core/ledger.js';
import {
  newSimState,
  firstFailure,
  attempt as simAttempt,
  mulberry32,
  RECOVERABLE,
  type SimState,
} from './gateway.js';
import { HOUR } from './clock.js';

const ENTRY_RAILS = ['upi', 'upi', 'upi', 'card', 'card', 'netbanking', 'wallet'];
const GRID_RAILS = ['upi', 'card', 'card_token', 'netbanking', 'wallet', 'emi', 'paylater'];
const GRID_DELAYS_H = [0.25, 1, 2, 4, 8, 16, 24, 48, 72, 120];
const FIXED_SCHEDULE_H = [1, 6, 24];

const MAX_ATTEMPTS = 4;
const ATTEMPT_COST_PAISE = 250; // what it costs to ask again

export type Arm = 'naive_fixed' | 'rules_guarded' | 'rules_rail_switch' | 'rebound';

/** What a competent rules engine falls back to. Fixed, not learned: a rules
 *  engine has no way to know that a limit failure specifically wants EMI. */
const FALLBACK_RAIL: Record<string, string> = {
  upi: 'card',
  card: 'upi',
  card_token: 'upi',
  netbanking: 'upi',
  wallet: 'upi',
  emi: 'upi',
  paylater: 'upi',
};

interface Case {
  seed: number;
  st: SimState;
  originalRail: string;
  amountPaise: number;
  startMs: number;
}

export interface ArmResult {
  arm: Arm;
  label: string;
  orders: number;
  recovered: number;
  recovered_value: number;
  ceiling_count: number;
  ceiling_value: number;
  capture_of_ceiling: number;
  attempts: number;
  retries: number;
  wasted_retries: number;
  attempt_cost_paise: number;
  net_value: number;
}

/** Build the population once. Every arm replays this exact list. */
function buildCases(n: number, seed: number): Case[] {
  const rnd = mulberry32(seed);
  const cases: Case[] = [];
  for (let i = 0; i < n; i++) {
    const st = newSimState(rnd);
    const r = rnd();
    const amountPaise =
      r < 0.55
        ? Math.round((150 + rnd() * 900) * 100)
        : r < 0.85
          ? Math.round((1000 + rnd() * 4000) * 100)
          : Math.round((5000 + rnd() * 25000) * 100);
    cases.push({
      seed: st.seed,
      st,
      originalRail: ENTRY_RAILS[Math.floor(rnd() * ENTRY_RAILS.length)],
      amountPaise,
      startMs: Date.UTC(2026, 7, 1 + Math.floor(rnd() * 28), Math.floor(rnd() * 24), 0, 0),
    });
  }
  return cases;
}

/** Fresh, identical sim state per arm. Replaying must not inherit the
 *  ghostCharged / mutation side effects of a previous arm. */
const cloneState = (c: Case): SimState => ({ ...c.st, ghostCharged: false });

interface Live {
  c: Case;
  st: SimState;
  attemptNo: number;
  elapsed: number;
  reason: string;
  source: string;
  cls: string;
  railsTried: Set<string>;
  done: boolean;
  won: boolean;
  attempts: number;
  retries: number;
}

async function batchScore(rows: Record<string, unknown>[]): Promise<number[]> {
  if (!rows.length) return [];
  try {
    const res = await fetch(`${env.decisionUrl}/score_batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return rows.map(() => 0.2);
    const j = (await res.json()) as { p: number[] };
    return j.p ?? rows.map(() => 0.2);
  } catch {
    return rows.map(() => 0.2);
  }
}

/**
 * Run one arm over the shared population.
 *
 * Structured round by round rather than order by order: at each round every
 * still-live order proposes its candidate grid, all of them are scored in ONE
 * model call, and then each order advances. Same decisions, one round trip
 * instead of thousands.
 */
export async function runArm(arm: Arm, cases: Case[]): Promise<ArmResult> {
  const live: Live[] = cases.map((c) => {
    const st = cloneState(c);
    const first = firstFailure(st.cohort, mulberry32(c.seed ^ 0x9e3779b9));
    return {
      c,
      st,
      attemptNo: 1,
      elapsed: 0,
      reason: first.error_reason ?? 'unknown',
      source: first.error_source ?? 'unknown',
      cls: classify(first),
      railsTried: new Set([c.originalRail]),
      done: false,
      won: false,
      attempts: 1, // the original charge that failed
      retries: 0,
    };
  });

  for (let round = 0; round < MAX_ATTEMPTS - 1; round++) {
    const active = live.filter((l) => !l.done && l.attemptNo < MAX_ATTEMPTS);
    if (!active.length) break;

    // --- choose (rail, delay) for each active order -----------------------
    const plans: ({ rail: string; delayH: number } | null)[] = [];

    if (arm === 'rebound') {
      const rows: Record<string, unknown>[] = [];
      const owner: number[] = [];
      active.forEach((l, idx) => {
        // Same guardrail the live policy applies first.
        if (l.cls === 'hard' || l.cls === 'ambiguous') return;
        for (const rail of GRID_RAILS) {
          for (const dh of GRID_DELAYS_H) {
            rows.push({
              amount_paise: l.c.amountPaise,
              attempt_no: l.attemptNo,
              hours_since_first_failure: l.elapsed / HOUR,
              delay_hours: dh,
              decline_class: l.cls,
              error_reason: l.reason,
              error_source: l.source,
              original_rail: l.c.originalRail,
              candidate_rail: rail,
              hour_of_day: new Date(l.c.startMs + l.elapsed + dh * HOUR).getUTCHours(),
              day_of_month: new Date(l.c.startMs + l.elapsed + dh * HOUR).getUTCDate(),
              prior_attempts: l.attemptNo,
              rails_tried: l.railsTried.size,
            });
            owner.push(idx);
          }
        }
      });

      const ps = await batchScore(rows);

      // Best expected value per order, exactly as the live policy computes it.
      const best = new Map<number, { rail: string; delayH: number; ev: number }>();
      rows.forEach((row, i) => {
        const idx = owner[i];
        const l = active[idx];
        const rail = row.candidate_rail as string;
        const net = l.c.amountPaise - feeFor(rail, l.c.amountPaise);
        const ev = Math.round(ps[i] * net) - ATTEMPT_COST_PAISE;
        const cur = best.get(idx);
        if (!cur || ev > cur.ev) best.set(idx, { rail, delayH: row.delay_hours as number, ev });
      });

      active.forEach((l, idx) => {
        if (l.cls === 'hard' || l.cls === 'ambiguous') return plans.push(null);
        const b = best.get(idx);
        // EV-negative means asking again costs more than it is worth.
        plans.push(b && b.ev > 0 ? { rail: b.rail, delayH: b.delayH } : null);
      });
    } else {
      active.forEach((l) => {
        if (arm !== 'naive_fixed' && l.cls === 'hard') return plans.push(null);
        const dh = FIXED_SCHEDULE_H[Math.min(round, FIXED_SCHEDULE_H.length - 1)];
        // The rail-switching arm gives up on the original instrument for its
        // last attempt -- the strongest thing a rules engine reasonably does.
        const rail =
          arm === 'rules_rail_switch' && round >= FIXED_SCHEDULE_H.length - 1
            ? (FALLBACK_RAIL[l.c.originalRail] ?? 'upi')
            : l.c.originalRail;
        plans.push({ rail, delayH: dh });
      });
    }

    // --- execute ----------------------------------------------------------
    active.forEach((l, idx) => {
      const plan = plans[idx];
      if (!plan) {
        l.done = true;
        return;
      }
      const nextElapsed = l.elapsed + plan.delayH * HOUR;
      const at = l.c.startMs + nextElapsed;
      const rnd = mulberry32(l.c.seed + (l.attemptNo + 1) * 7919);
      const res = simAttempt(
        l.st,
        plan.rail,
        l.c.originalRail,
        nextElapsed,
        l.c.amountPaise,
        rnd,
        at,
      );

      l.attempts++;
      l.retries++;
      l.attemptNo++;
      l.elapsed = nextElapsed;
      l.railsTried.add(plan.rail);

      if (res.status === 'succeeded') {
        l.won = true;
        l.done = true;
        return;
      }
      // An ambiguous outcome resolves against the provider before anything
      // else happens -- the same rule the live system enforces.
      if (res.status === 'unknown') {
        if (res.truth === 'captured') {
          l.won = true;
          l.done = true;
          return;
        }
        l.cls = 'soft';
        return;
      }
      if (res.error_reason) {
        l.reason = res.error_reason;
        l.source = res.error_source ?? 'unknown';
        l.cls = classify(res);
      }
    });
  }

  const ceiling = live.filter((l) => RECOVERABLE[l.c.st.cohort]);
  const won = live.filter((l) => l.won);
  const wasted = live
    .filter((l) => !RECOVERABLE[l.c.st.cohort])
    .reduce((a, l) => a + l.retries, 0);
  const attempts = live.reduce((a, l) => a + l.attempts, 0);
  const retries = live.reduce((a, l) => a + l.retries, 0);
  const recovered_value = won.reduce((a, l) => a + l.c.amountPaise, 0);
  const ceiling_value = ceiling.reduce((a, l) => a + l.c.amountPaise, 0);

  const LABELS: Record<Arm, string> = {
    naive_fixed: 'Fixed 1h/6h/24h, same rail, retries everything',
    rules_guarded: 'Rules engine: same schedule, skips hard declines',
    rules_rail_switch: 'Rules engine + rail switch on the last attempt',
    rebound: 'Rebound: model-ranked EV over rail x delay',
  };

  return {
    arm,
    label: LABELS[arm],
    orders: live.length,
    recovered: won.length,
    recovered_value,
    ceiling_count: ceiling.length,
    ceiling_value,
    capture_of_ceiling: ceiling_value ? Number((recovered_value / ceiling_value).toFixed(4)) : 0,
    attempts,
    retries,
    wasted_retries: wasted,
    attempt_cost_paise: retries * ATTEMPT_COST_PAISE,
    net_value: recovered_value - retries * ATTEMPT_COST_PAISE,
  };
}

export async function runExperiment(n: number, seed: number) {
  const cases = buildCases(n, seed);
  const arms: Arm[] = ['naive_fixed', 'rules_guarded', 'rules_rail_switch', 'rebound'];
  const results: ArmResult[] = [];
  for (const a of arms) results.push(await runArm(a, cases));

  const ours = results.find((r) => r.arm === 'rebound')!;
  // Deliberately the best-performing non-model arm, whichever that turns out
  // to be. Picking a fixed comparator would let a weak baseline flatter the
  // result on some seeds.
  const base = results
    .filter((r) => r.arm !== 'rebound')
    .sort((a, b) => b.recovered_value - a.recovered_value)[0];

  return {
    n,
    seed,
    results,
    delta: {
      // Whichever rules arm did best. Beating the weakest one proves little.
      vs: base.arm,
      extra_recovered_paise: ours.recovered_value - base.recovered_value,
      extra_recovered_pct: base.recovered_value
        ? Number((((ours.recovered_value - base.recovered_value) / base.recovered_value) * 100).toFixed(1))
        : 0,
      capture_points: Number(((ours.capture_of_ceiling - base.capture_of_ceiling) * 100).toFixed(1)),
      retries_saved: base.retries - ours.retries,
      wasted_retries_saved: base.wasted_retries - ours.wasted_retries,
      net_value_delta: ours.net_value - base.net_value,
    },
  };
}

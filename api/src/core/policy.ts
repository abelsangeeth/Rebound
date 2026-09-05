import { env } from './env.js';
import { classify, isAffordability } from './taxonomy.js';
import { feeFor } from './ledger.js';
import { railScores, thompsonPick } from './rails.js';
import { mulberry32 } from '../sim/gateway.js';
import { buildFeatures, type OrderRow, type AttemptRow } from './features.js';
import { clock } from '../sim/clock.js';
import { q, one } from './db.js';

export interface Decision {
  should_retry: boolean;
  delay_seconds: number;
  rail: string;
  p_success: number;
  ev_paise: number;
  policy: string;
  reasons: string[];
  candidates?: { rail: string; delay: number; p: number; ev: number }[];
  shap?: { feature: string; contribution: number }[];
}

/** Cost of making one more attempt: the nudge, the gateway call, the sliver of
 *  support load. Small, but it is what stops the system retrying a 2% chance
 *  forever. */
const ATTEMPT_COST_PAISE = 100;

const DELAY_GRID = [900, 7200, 21600, 86400, 259200]; // 15m, 2h, 6h, 24h, 72h

function candidateRails(order: OrderRow, last: AttemptRow): string[] {
  const orig = order.original_rail ?? last.rail;
  const set = new Set<string>([orig, 'upi']);
  // A card retry only becomes safe and cheap once the instrument is tokenised;
  // post-RBI you cannot store the PAN, so the token IS the retryable handle.
  if (orig === 'card' || orig === 'card_token') set.add('card_token');
  // Do not re-ask for money the customer demonstrably does not have in one
  // lump. Change the shape of the ask instead.
  if (isAffordability(last)) {
    set.add('emi');
    set.add('paylater');
  }
  return [...set];
}

/**
 * Anti-card-testing guardrail.
 *
 * A recovery engine that retries aggressively is indistinguishable, from the
 * network's side, from a bot probing stolen cards. If one customer is
 * generating a burst of failures across many instruments, we stop -- before
 * the acquirer stops us.
 */
export async function cardTestingRisk(customerId: string): Promise<{ block: boolean; n: number }> {
  const r = await one<{ fails: number; rails: number }>(
    `SELECT COUNT(*)::int AS fails, COUNT(DISTINCT pa.rail)::int AS rails
       FROM payment_attempts pa
       JOIN orders o ON o.id = pa.order_id
      WHERE o.customer_id = $1
        AND pa.status = 'failed'
        AND pa.created_at > now() - interval '1 hour'`,
    [customerId],
  );
  const fails = r?.fails ?? 0;
  const rails = r?.rails ?? 0;
  return { block: fails >= 8 || (fails >= 5 && rails >= 3), n: fails };
}

/** Ask the ML service for P(success) across the candidate grid. Returns null
 *  if it is unreachable, and the caller falls back to rules. */
async function scoreGrid(
  base: Record<string, unknown>,
  rails: string[],
): Promise<{ grid: any[]; shap: any[] } | null> {
  try {
    const ctl = AbortSignal.timeout(2500);
    const res = await fetch(`${env.decisionUrl}/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base, rails, delays: DELAY_GRID }),
      signal: ctl,
    });
    if (!res.ok) return null;
    return (await res.json()) as { grid: any[]; shap: any[] };
  } catch {
    return null;
  }
}

/** Heuristic used when the model is unavailable. This is also the BASELINE the
 *  model has to beat: fixed 24h retry on the same rail, no rail switching, no
 *  timing. It is what most recovery today actually does. */
export function rulesFallback(order: OrderRow, last: AttemptRow): Decision {
  const cls = last.decline_class ?? classify(last);
  if (cls === 'hard') {
    return {
      should_retry: false, delay_seconds: 0, rail: last.rail, p_success: 0, ev_paise: 0,
      policy: 'rules', reasons: ['hard decline: instrument will not work later'],
    };
  }
  const p = 0.25;
  const ev = Math.round(p * (order.amount_paise - feeFor(last.rail, order.amount_paise))) - ATTEMPT_COST_PAISE;
  return {
    should_retry: true, delay_seconds: 86400, rail: last.rail, p_success: p, ev_paise: ev,
    policy: 'rules', reasons: ['model unavailable: fixed 24h retry on the original rail'],
  };
}

/**
 * The decision.
 *
 * Order matters. Deterministic guardrails run FIRST and can only ever say no.
 * The model runs second and can only ever rank options the guardrails already
 * allowed. There is no path by which a model output alone causes a charge --
 * that separation is the whole reason this is safe to point at real money.
 */
export async function decide(
  order: OrderRow,
  last: AttemptRow,
  priorAttempts: number,
  railsTried: number,
): Promise<Decision> {
  const reasons: string[] = [];
  const cls = last.decline_class ?? classify(last);

  // --- guardrails ---------------------------------------------------------
  if (cls === 'hard') {
    return {
      should_retry: false, delay_seconds: 0, rail: last.rail, p_success: 0, ev_paise: 0,
      policy: 'guardrail',
      reasons: [`hard decline (${last.error_reason}): no schedule and no rail recovers this`],
    };
  }
  if (cls === 'ambiguous') {
    return {
      should_retry: false, delay_seconds: 0, rail: last.rail, p_success: 0, ev_paise: 0,
      policy: 'guardrail',
      reasons: ['outcome unknown: must reconcile with the provider before any retry'],
    };
  }
  const risk = await cardTestingRisk(order.customer_id);
  if (risk.block) {
    return {
      should_retry: false, delay_seconds: 0, rail: last.rail, p_success: 0, ev_paise: 0,
      policy: 'guardrail',
      reasons: [`${risk.n} failures for this customer in the last hour: looks like card testing, standing down`],
    };
  }

  // --- ranking ------------------------------------------------------------
  const rails = candidateRails(order, last);
  const now = clock.now();
  const base = buildFeatures(order, last, rails[0], priorAttempts, railsTried, now);
  const scored = await scoreGrid(base as any, rails);

  if (!scored) {
    const fb = rulesFallback(order, last);
    fb.reasons.push('decision service unreachable');
    return fb;
  }

  const scores = await railScores();
  const openRails = new Set(scores.filter((s) => s.breaker_open).map((s) => s.rail));
  if (openRails.size) reasons.push(`circuit breaker open on ${[...openRails].join(', ')}`);

  const cands = scored.grid
    .filter((g: any) => !openRails.has(g.rail))
    .map((g: any) => {
      const net = order.amount_paise - feeFor(g.rail, order.amount_paise);
      return { rail: g.rail, delay: g.delay, p: g.p, ev: Math.round(g.p * net) - ATTEMPT_COST_PAISE };
    })
    .sort((a: any, b: any) => b.ev - a.ev);

  if (!cands.length) {
    return {
      should_retry: false, delay_seconds: 0, rail: last.rail, p_success: 0, ev_paise: 0,
      policy: 'guardrail', reasons: ['every candidate rail is circuit-broken'],
    };
  }

  let best = cands[0];

  // Exploration. Among options whose EV is within 8% of the best, let the
  // bandit choose -- so a rail we have little data on still gets traffic and
  // can prove itself, without ever spending money on an option the EV maths
  // has already ruled out.
  const near = cands.filter((c: any) => c.ev >= best.ev * 0.92 && c.ev > 0);
  if (near.length > 1) {
    const rnd = mulberry32(Math.floor(now / 1000) ^ order.amount_paise);
    const pick = thompsonPick(scores, [...new Set(near.map((c: any) => c.rail))], rnd);
    const chosen = near.find((c: any) => c.rail === pick.rail);
    if (chosen && chosen.rail !== best.rail) {
      reasons.push(`bandit explored ${chosen.rail} over ${best.rail} (EV within 8%)`);
      best = chosen;
    }
  }

  if (best.ev <= 0) {
    return {
      should_retry: false, delay_seconds: 0, rail: best.rail, p_success: best.p, ev_paise: best.ev,
      policy: 'ev',
      reasons: [`best option is EV-negative (${(best.p * 100).toFixed(1)}% x value < cost of asking)`],
    };
  }

  reasons.unshift(
    `${(best.p * 100).toFixed(1)}% on ${best.rail} in ${humanDelay(best.delay)} beats ${cands.length - 1} alternatives`,
  );
  if (best.rail !== (order.original_rail ?? last.rail)) {
    reasons.push(`switching rail from ${order.original_rail ?? last.rail} to ${best.rail}`);
  }

  return {
    should_retry: true,
    delay_seconds: best.delay,
    rail: best.rail,
    p_success: best.p,
    ev_paise: best.ev,
    policy: 'model+ev',
    reasons,
    candidates: cands.slice(0, 8),
    shap: scored.shap,
  };
}

export function humanDelay(s: number) {
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

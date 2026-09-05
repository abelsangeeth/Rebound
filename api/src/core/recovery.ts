import { randomUUID } from 'node:crypto';
import { q, one, tx, isUniqueViolation, pool } from './db.js';
import { classify, isIssuerSide, type DeclineClass } from './taxonomy.js';
import { postCapture, feeFor } from './ledger.js';
import { scheduleRetry } from './redis.js';
import { clock } from '../sim/clock.js';
import { attempt as simAttempt, mulberry32, type SimState } from '../sim/gateway.js';
import { decide, type Decision } from './policy.js';
import { recordRailOutcome } from './rails.js';

export const RAILS = ['upi', 'card', 'card_token', 'netbanking', 'wallet', 'emi', 'paylater'];
export const MAX_ATTEMPTS = 4;

export type { OrderRow, AttemptRow, Features } from './features.js';
export { buildFeatures } from './features.js';
import type { OrderRow, AttemptRow } from './features.js';

export async function getOrder(id: string) {
  return one<OrderRow>('SELECT * FROM orders WHERE id=$1', [id]);
}

export async function attemptsFor(orderId: string) {
  return q<AttemptRow>(
    'SELECT * FROM payment_attempts WHERE order_id=$1 ORDER BY attempt_no',
    [orderId],
  );
}

/**
 * Open a new attempt.
 *
 * The INSERT is the idempotency mechanism. (order_id, attempt_no, rail) is
 * UNIQUE, so if anything -- a duplicate webhook, a double-fired timer, two
 * workers racing -- tries to open the same attempt twice, the second one gets
 * a constraint violation and we hand back the row that already exists. No
 * distributed lock, no compare-and-set, no window where both callers think
 * they won. The database is the referee.
 */
export async function openAttempt(
  orderId: string,
  attemptNo: number,
  rail: string,
  amountPaise: number,
): Promise<{ row: AttemptRow; fresh: boolean }> {
  try {
    const row = await one<AttemptRow>(
      `INSERT INTO payment_attempts (order_id, attempt_no, rail, amount_paise, status)
       VALUES ($1,$2,$3,$4,'pending') RETURNING *`,
      [orderId, attemptNo, rail, amountPaise],
    );
    return { row: row!, fresh: true };
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const row = await one<AttemptRow>(
      'SELECT * FROM payment_attempts WHERE order_id=$1 AND attempt_no=$2 AND rail=$3',
      [orderId, attemptNo, rail],
    );
    return { row: row!, fresh: false };
  }
}

/** Settle a winning attempt: mark it, mark the order, post the ledger.
 *  All three in one transaction, so there is no instant where the order is
 *  paid but the ledger has not moved. */
export async function settle(attemptId: string, orderId: string, providerPaymentId?: string) {
  return tx(async (c) => {
    const a = (
      await c.query(
        `UPDATE payment_attempts
            SET status='succeeded', resolved_at=now(), provider_payment_id=COALESCE($2, provider_payment_id)
          WHERE id=$1 AND status <> 'succeeded'
          RETURNING *`,
        [attemptId, providerPaymentId ?? null],
      )
    ).rows[0];
    if (!a) return { settled: false };

    await c.query(
      `UPDATE orders SET status='paid', paid_at=now() WHERE id=$1 AND status <> 'paid'`,
      [orderId],
    );
    const fee = feeFor(a.rail, Number(a.amount_paise));
    const group = await postCapture(c, orderId, attemptId, Number(a.amount_paise), fee);
    return { settled: true, ledgerGroup: group };
  });
}

export async function markFailed(attemptId: string, o: Record<string, unknown>, cls: DeclineClass) {
  await q(
    `UPDATE payment_attempts
        SET status=$2, resolved_at=now(), error_code=$3, error_reason=$4,
            error_source=$5, error_step=$6, error_description=$7, decline_class=$8
      WHERE id=$1`,
    [
      attemptId,
      o.status === 'unknown' ? 'unknown' : 'failed',
      o.error_code ?? null,
      o.error_reason ?? null,
      o.error_source ?? null,
      o.error_step ?? null,
      o.error_description ?? null,
      cls,
    ],
  );
}

/** True if any attempt on this order is still in the unknown state. While one
 *  is, nothing may be retried -- that is the double-charge guard. */
export async function hasUnresolvedAmbiguity(orderId: string): Promise<boolean> {
  const r = await one<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM payment_attempts
      WHERE order_id=$1 AND status='unknown'`,
    [orderId],
  );
  return (r?.n ?? 0) > 0;
}

export const retryToken = (o: string, n: number, r: string) => `retry|${o}|${n}|${r}`;
export const reconToken = (o: string, n: number) => `recon|${o}|${n}`;

/**
 * Execute one attempt end to end.
 *
 * Refuses in two cases that matter: an unresolved ambiguous attempt (retrying
 * could double-charge) and an already-paid order.
 */
export async function runAttempt(orderId: string, attemptNo: number, rail: string) {
  const order = await getOrder(orderId);
  if (!order) return { ok: false, reason: 'no_such_order' };
  if (order.status === 'paid') return { ok: false, reason: 'already_paid' };

  if (attemptNo > 1 && (await hasUnresolvedAmbiguity(orderId))) {
    // The correct move is to reconcile, not to try again.
    return { ok: false, reason: 'blocked_ambiguous' };
  }

  const { row, fresh } = await openAttempt(orderId, attemptNo, rail, order.amount_paise);
  if (!fresh) return { ok: false, reason: 'duplicate_attempt', attemptId: row.id };

  const st = order.sim_state;
  if (!st) return { ok: false, reason: 'no_sim_state' };

  const now = clock.now();
  const firstFailed = order.first_failed_at?.getTime() ?? now;
  const elapsed = attemptNo === 1 ? 0 : now - firstFailed;
  const rnd = mulberry32(st.seed + attemptNo * 7919);
  const outcome = simAttempt(
    st,
    rail,
    order.original_rail ?? rail,
    elapsed,
    order.amount_paise,
    rnd,
    now,
  );

  // What the provider knows. Reconciliation is allowed to read this; the
  // policy is not.
  const truths = { ...((st as any).truths ?? {}), [attemptNo]: outcome.truth };
  const underlying = { ...((st as any).underlying ?? {}), [attemptNo]: outcome.underlying ?? null };
  await q('UPDATE orders SET sim_state = sim_state || $2::jsonb WHERE id=$1', [
    orderId,
    JSON.stringify({ truths, underlying, ghostCharged: st.ghostCharged }),
  ]);

  await recordRailOutcome(rail, outcome.status === 'succeeded', isIssuerSide(outcome));
  return handleOutcome(order, row, outcome);
}

async function handleOutcome(order: OrderRow, att: AttemptRow, outcome: any) {
  if (outcome.status === 'succeeded') {
    const r = await settle(att.id, order.id, outcome.provider_payment_id);
    return { ok: true, status: 'succeeded', attemptId: att.id, ...r };
  }

  const cls = classify(outcome);
  await markFailed(att.id, outcome, cls);

  if (att.attempt_no === 1) {
    await q(
      `UPDATE orders
          SET status='recovering', original_rail=COALESCE(original_rail,$2), first_failed_at=now()
        WHERE id=$1 AND status='created'`,
      [order.id, att.rail],
    );
  }

  if (outcome.status === 'unknown') {
    // Do NOT retry. Do NOT mark failed. Ask the provider what really happened,
    // shortly, with backoff. Until that answers, this order is frozen.
    const delay = 90_000 * Math.pow(2, att.attempt_no - 1);
    await scheduleRetry(reconToken(order.id, att.attempt_no), clock.now() + delay);
    return { ok: true, status: 'unknown', attemptId: att.id, action: 'reconcile_scheduled' };
  }

  const plan = await planNext(order.id);
  return { ok: true, status: 'failed', declineClass: cls, attemptId: att.id, plan };
}

/** Ask the policy what to do next, record the answer, act on it. */
export async function planNext(orderId: string): Promise<Decision | null> {
  const order = await getOrder(orderId);
  if (!order || order.status === 'paid') return null;

  const atts = await attemptsFor(orderId);
  const last = atts[atts.length - 1];
  if (!last) return null;

  if (atts.length >= MAX_ATTEMPTS) {
    await q(`UPDATE orders SET status='abandoned' WHERE id=$1 AND status<>'paid'`, [orderId]);
    return null;
  }

  const railsTried = new Set(atts.map((a) => a.rail)).size;
  const d = await decide(order, last, atts.length, railsTried);

  await q(
    `INSERT INTO decisions (order_id, after_attempt, should_retry, delay_seconds, rail,
                            p_success, ev_paise, policy, reasons)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      orderId,
      last.attempt_no,
      d.should_retry,
      d.delay_seconds,
      d.rail,
      d.p_success,
      d.ev_paise,
      d.policy,
      JSON.stringify(d.reasons),
    ],
  );

  if (!d.should_retry) {
    await q(`UPDATE orders SET status='abandoned' WHERE id=$1 AND status<>'paid'`, [orderId]);
    return d;
  }

  await scheduleRetry(
    retryToken(orderId, last.attempt_no + 1, d.rail),
    clock.now() + d.delay_seconds * 1000,
  );
  return d;
}

/**
 * Resolve an ambiguous attempt by asking the provider what it actually has.
 *
 * This is the only correct exit from a timeout. Not a retry, not a guess, not
 * a timer that assumes failure. If the money was taken, we settle it and the
 * customer is charged once. If it was not, we release the freeze and the
 * policy is allowed to plan again.
 */
export async function reconcile(orderId: string, attemptNo: number) {
  const order = await getOrder(orderId);
  if (!order) return { ok: false, reason: 'no_such_order' };

  const att = await one<AttemptRow>(
    'SELECT * FROM payment_attempts WHERE order_id=$1 AND attempt_no=$2',
    [orderId, attemptNo],
  );
  if (!att) return { ok: false, reason: 'no_such_attempt' };
  if (att.status !== 'unknown') return { ok: true, reason: 'already_resolved' };

  // In production this is razorpay.fetchPaymentsForOrder(order.id) -- the
  // provider is the authority on what it captured, never our local state.
  const truth = (order.sim_state as any)?.truths?.[attemptNo];

  if (truth === 'captured') {
    const r = await settle(att.id, orderId);
    return { ok: true, resolved: 'captured', ...r };
  }

  // Not captured. The provider also tells us WHY it failed underneath the
  // timeout, and we must classify on that rather than on 'payment_timeout'.
  //
  // Marking every reconciled timeout 'soft' would be a quiet, expensive bug:
  // a dead card that happened to time out would come back looking retryable
  // and the hard-decline guardrail -- which only ever reads decline_class --
  // would wave it straight through. The timeout described our knowledge of
  // the attempt, not the health of the instrument.
  const underlying = (order.sim_state as any)?.underlying?.[attemptNo] ?? null;
  const sig = underlying ?? { error_reason: 'unknown' };
  const cls = classify(sig);

  await q(
    `UPDATE payment_attempts
        SET status='failed', resolved_at=now(), decline_class=$2,
            error_reason=COALESCE($3, error_reason),
            error_source=COALESCE($4, error_source),
            error_step=COALESCE($5, error_step)
      WHERE id=$1 AND status='unknown'`,
    [att.id, cls, sig.error_reason ?? null, sig.error_source ?? null, sig.error_step ?? null],
  );
  const plan = await planNext(orderId);
  return { ok: true, resolved: 'not_captured', declineClass: cls, plan };
}

export interface NewOrder {
  merchantId: string;
  customerId: string;
  amountPaise: number;
  rail: string;
  simState: SimState;
  createdAt?: Date;
}

export async function createOrder(o: NewOrder) {
  const id = `order_${randomUUID().replace(/-/g, '').slice(0, 18)}`;
  const { RECOVERABLE } = await import('../sim/gateway.js');
  await q(
    `INSERT INTO orders (id, merchant_id, customer_id, amount_paise, status,
                         sim_recoverable, sim_cohort, sim_state, original_rail, created_at)
     VALUES ($1,$2,$3,$4,'created',$5,$6,$7,$8,COALESCE($9, now()))`,
    [
      id,
      o.merchantId,
      o.customerId,
      o.amountPaise,
      RECOVERABLE[o.simState.cohort],
      o.simState.cohort,
      JSON.stringify(o.simState),
      o.rail,
      o.createdAt ?? null,
    ],
  );
  return id;
}

export { pool };

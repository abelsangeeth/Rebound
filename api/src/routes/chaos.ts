import type { FastifyInstance } from 'fastify';
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { q, one, tx } from '../core/db.js';
import { env } from '../core/env.js';
import { createOrder, runAttempt, openAttempt, reconcile } from '../core/recovery.js';
import { postCapture, postGroup, UnbalancedEntry } from '../core/ledger.js';
import { newSimState, mulberry32 } from '../sim/gateway.js';
import { clock } from '../sim/clock.js';

// Chaos console.
//
// Every endpoint here tries to break one specific invariant on purpose, then
// reports what the system did about it. Claiming "exactly-once" is easy;
// letting someone press a button that attempts a double charge and watching
// the constraint refuse it is the part that counts.

async function invariantState() {
  const rows = await q<any>(`SELECT name, ok, observed FROM invariants ORDER BY name`);
  return { all_ok: rows.every((r) => r.ok), invariants: rows };
}

async function log(kind: string, detail: unknown) {
  await q(`INSERT INTO chaos_events (kind, detail) VALUES ($1,$2)`, [kind, JSON.stringify(detail)]);
}

/**
 * A distinct seed per press.
 *
 * These endpoints used to seed off the wall clock, which advances far more
 * slowly than the button can be clicked -- so two quick presses replayed the
 * byte-identical order and the console looked deterministic when it is not.
 * The simulation itself stays reproducible: each order still carries its own
 * stored seed. Only the choice of which order to stage is randomised.
 */
function freshSeed(): number {
  return randomInt(0, 2 ** 31 - 1);
}

async function payableFor(orderId: string): Promise<number> {
  const r = await one<{ v: number }>(
    `SELECT COALESCE(SUM(amount_paise),0)::bigint AS v FROM ledger_entries
      WHERE order_id=$1 AND account='merchant_payable' AND direction='credit'`,
    [orderId],
  );
  return Number(r?.v ?? 0);
}

export default async function registerChaos(app: FastifyInstance) {
  /** Replay a webhook we have already processed, byte for byte, correctly
   *  signed. The provider does this in production whenever an ack is lost. */
  app.post('/duplicate-webhook', async (req) => {
    const { times } = (req.body ?? {}) as { times?: number };
    const n = Math.min(Number(times ?? 3), 25);

    const paid = await one<any>(
      `SELECT pa.order_id, pa.provider_payment_id, o.amount_paise
         FROM payment_attempts pa JOIN orders o ON o.id = pa.order_id
        WHERE pa.status='succeeded' ORDER BY pa.resolved_at DESC LIMIT 1`,
    );
    if (!paid) return { ok: false, reason: 'no captured payment yet -- start the simulator first' };

    const body = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paid.provider_payment_id ?? 'pay_chaos',
            amount: Number(paid.amount_paise),
            status: 'captured',
            notes: { rebound_order: paid.order_id },
          },
        },
      },
    });

    const before = await payableFor(paid.order_id);
    const responses = [];
    // Same event id every time -- this is a replay, not a new event.
    const eventId = `evt_chaos_replay_${paid.order_id}`;
    const sig = createHmac('sha256', env.razorpayWebhookSecret).update(body).digest('hex');

    for (let i = 0; i < n; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/razorpay',
        headers: {
          'content-type': 'application/json',
          'x-razorpay-signature': sig,
          'x-razorpay-event-id': eventId,
        },
        payload: body,
      });
      responses.push({ status: res.statusCode, body: res.json() });
    }

    const after = await payableFor(paid.order_id);
    await log('duplicate_webhook', { order: paid.order_id, times: n, before, after });

    return {
      ok: true,
      what: `replayed the same signed payment.captured event ${n} times`,
      order_id: paid.order_id,
      merchant_payable_before_paise: before,
      merchant_payable_after_paise: after,
      verdict:
        after === before
          ? 'ledger unchanged -- dedupe held, the merchant was credited exactly once'
          : 'LEDGER MOVED -- exactly-once is broken',
      responses,
      ...(await invariantState()),
    };
  });

  /** Forge a webhook with a wrong signature. Must be rejected before the body
   *  is trusted for anything at all. */
  app.post('/forged-webhook', async () => {
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: { entity: { id: 'pay_forged', notes: { rebound_order: 'order_forged' } } },
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/razorpay',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': 'f'.repeat(64),
        'x-razorpay-event-id': `evt_forged_${Date.now()}`,
      },
      payload: body,
    });
    await log('forged_webhook', { status: res.statusCode });
    return {
      ok: true,
      what: 'posted a payment.captured event carrying an invalid HMAC',
      status: res.statusCode,
      verdict:
        res.statusCode === 401
          ? 'rejected at the signature check, before the payload was parsed or trusted'
          : 'ACCEPTED -- signature verification is broken',
      ...(await invariantState()),
    };
  });

  /**
   * Fire the same retry token twice, concurrently. This is what a
   * double-fired timer, a redelivered queue message or two workers racing
   * actually looks like.
   */
  app.post('/double-retry', async () => {
    const target = await one<any>(
      `SELECT o.id, o.amount_paise, pa.attempt_no, pa.rail
         FROM orders o JOIN payment_attempts pa ON pa.order_id = o.id
        WHERE o.status='recovering' AND pa.status='failed'
        ORDER BY pa.created_at DESC LIMIT 1`,
    );
    if (!target) return { ok: false, reason: 'no order in recovery yet -- start the simulator' };

    const next = target.attempt_no + 1;
    // Deliberately not awaited in sequence: both go in flight together.
    const [a, b] = await Promise.all([
      runAttempt(target.id, next, target.rail).catch((e) => ({ ok: false, reason: e.message })),
      runAttempt(target.id, next, target.rail).catch((e) => ({ ok: false, reason: e.message })),
    ]);

    const rows = await q<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM payment_attempts
        WHERE order_id=$1 AND attempt_no=$2 AND rail=$3`,
      [target.id, next, target.rail],
    );
    const created = rows[0]?.n ?? 0;
    await log('double_retry', { order: target.id, attempt: next, created });

    return {
      ok: true,
      what: `fired retry (attempt ${next}, ${target.rail}) twice at the same instant`,
      order_id: target.id,
      attempt_rows_created: created,
      results: [a, b],
      verdict:
        created === 1
          ? 'one attempt row exists -- the UNIQUE (order_id, attempt_no, rail) constraint refused the second'
          : `${created} attempt rows -- idempotency is broken`,
      ...(await invariantState()),
    };
  });

  /**
   * The double-charge trap, staged deliberately.
   *
   * Create an order whose next attempt times out AFTER the issuer has taken
   * the money. The app is told nothing conclusive. Then try to retry it. A
   * naive engine charges the customer twice here; this one must refuse and
   * reconcile instead.
   */
  app.post('/ghost-timeout', async () => {
    const rnd = mulberry32(freshSeed());
    const st = newSimState(rnd);
    st.cohort = 'flaky_network';
    st.unlockAt = 0;

    const orderId = await createOrder({
      merchantId: 'mrc_chaos',
      customerId: `cust_ghost_${Math.floor(rnd() * 1e6).toString(36)}`,
      amountPaise: 249900,
      rail: 'upi',
      simState: st,
      createdAt: clock.date(),
    });

    // Force the ambiguous state: an attempt that the provider actually
    // captured but never reported back.
    const { row } = await openAttempt(orderId, 1, 'upi', 249900);
    await q(
      `UPDATE payment_attempts
          SET status='unknown', decline_class='ambiguous', error_reason='payment_timeout',
              error_source='network', error_step='payment_response', resolved_at=NULL
        WHERE id=$1`,
      [row.id],
    );
    await q(
      `UPDATE orders SET status='recovering', first_failed_at=now(),
                         sim_state = sim_state || $2::jsonb
        WHERE id=$1`,
      [orderId, JSON.stringify({ truths: { 1: 'captured' } })],
    );

    const blocked = await runAttempt(orderId, 2, 'upi');
    const payableBefore = await payableFor(orderId);
    const recon = await reconcile(orderId, 1);
    const payableAfter = await payableFor(orderId);

    const attempts = await q<any>(
      `SELECT attempt_no, rail, status FROM payment_attempts WHERE order_id=$1 ORDER BY attempt_no`,
      [orderId],
    );
    await log('ghost_timeout', { order: orderId, blocked, recon });

    return {
      ok: true,
      what: 'staged a timeout where the issuer HAD taken the money, then tried to retry it',
      order_id: orderId,
      amount_paise: 249900,
      retry_result: blocked,
      reconciliation: recon,
      attempts,
      merchant_payable_before_paise: payableBefore,
      merchant_payable_after_paise: payableAfter,
      verdict:
        (blocked as any)?.reason === 'blocked_ambiguous' && payableAfter === 249900
          ? 'retry refused while the outcome was unknown; reconciliation then found the capture and credited it once'
          : 'the retry was NOT blocked -- this path can double-charge',
      ...(await invariantState()),
    };
  });

  /**
   * Try to write a ledger entry whose debits do not equal its credits. The
   * ledger must refuse rather than store a lie that the invariant view would
   * later report.
   */
  /**
   * Try to put a lie in the ledger.
   *
   * Note what this does NOT do: hand postCapture a wrong amount. That function
   * derives all three legs from the amount you give it, so the group balances
   * at whatever size you ask for -- the balance check never fires and the test
   * passes while attempting nothing. The legs themselves have to disagree.
   */
  app.post('/unbalanced-ledger', async () => {
    const target = await one<any>(`SELECT id, amount_paise FROM orders ORDER BY created_at DESC LIMIT 1`);
    if (!target) return { ok: false, reason: 'no orders yet -- start the simulator' };

    const amount = Number(target.amount_paise);
    // Each attack gets its own group id, so the verdict can be read back out
    // of the table rather than inferred from which catch block ran.
    const groupA = randomUUID();
    const groupB = randomUUID();

    // 1. A group that is short by 1000 paise, through the real posting path.
    let balanceCheckRejected = false;
    let rejection = '';
    try {
      await tx(async (c) => {
        await postGroup(
          c,
          target.id,
          [
            { account: 'gateway_clearing', direction: 'debit', amount_paise: amount },
            { account: 'merchant_payable', direction: 'credit', amount_paise: amount + 1000 },
          ],
          'chaos',
          groupA,
          'deliberately unbalanced',
        );
      });
    } catch (e) {
      balanceCheckRejected = e instanceof UnbalancedEntry;
      rejection = (e as Error).message;
    }

    // 2. A single-legged INSERT that skips postGroup entirely -- the check it
    //    would have failed is not in the transaction's way at all.
    let directThrew = false;
    try {
      await tx(async (c) => {
        await c.query(
          `INSERT INTO ledger_entries (entry_group, order_id, account, direction, amount_paise, ref_type, ref_id)
           VALUES ($1,$2,'merchant_payable','credit',$3,'chaos',$4)`,
          [groupB, target.id, 5000, groupB],
        );
        throw new UnbalancedEntry('single-legged entry rolled back');
      });
    } catch {
      directThrew = true;
    }

    // The verdict, read back from the table. Neither group may have left a row
    // behind. Catching an exception only proves something was thrown.
    const landed = await one<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM ledger_entries WHERE entry_group IN ($1::uuid, $2::uuid)`,
      [groupA, groupB],
    );
    const rowsLeftBehind = Number(landed?.n ?? 0);
    const inv = await invariantState();
    const clean = balanceCheckRejected && directThrew && rowsLeftBehind === 0 && inv.all_ok;

    await log('unbalanced_ledger', {
      order: target.id,
      balanceCheckRejected,
      directThrew,
      rowsLeftBehind,
    });
    return {
      ok: clean,
      what: 'posted a group whose legs disagree by 1000 paise, then a single-legged insert that bypasses the check',
      balance_check_rejected: balanceCheckRejected,
      rejection,
      single_leg_rolled_back: directThrew,
      rows_left_behind: rowsLeftBehind,
      verdict: clean
        ? 'both writes refused; the table holds no row from either group'
        : `LEDGER DAMAGED: ${rowsLeftBehind} row(s) committed`,
      ...inv,
    };
  });

  /** Hard decline a payment, then try to retry it anyway. */
  app.post('/retry-hard-decline', async () => {
    const rnd = mulberry32(freshSeed());
    const st = newSimState(rnd);
    st.cohort = 'dead_instrument';
    const orderId = await createOrder({
      merchantId: 'mrc_chaos',
      customerId: `cust_dead_${Math.floor(rnd() * 1e6).toString(36)}`,
      amountPaise: 89900,
      rail: 'card',
      simState: st,
      createdAt: clock.date(),
    });
    let first: any = await runAttempt(orderId, 1, 'card');

    // The simulated network drops ~3.5% of responses. On that path the attempt
    // is AMBIGUOUS, not declined, so the policy is never consulted and no
    // decision row exists -- reading one and calling its absence a guardrail
    // failure would make this button lie about 1 run in 30. Resolve the
    // ambiguity first, exactly as the worker would, then judge the policy.
    let viaReconcile = false;
    if (first?.status === 'unknown') {
      viaReconcile = true;
      first = { ...first, reconciled: await reconcile(orderId, 1) };
    }

    const decision = await one<any>(
      `SELECT should_retry, policy, reasons FROM decisions WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [orderId],
    );
    const order = await one<any>(`SELECT status FROM orders WHERE id=$1`, [orderId]);
    await log('retry_hard_decline', { order: orderId, decision });

    return {
      ok: true,
      what: 'sent a payment on a dead instrument (expired/blocked card) into the policy',
      order_id: orderId,
      first_attempt: first,
      resolved_via_reconciliation: viaReconcile,
      decision,
      order_status: order?.status,
      verdict:
        decision && decision.should_retry === false
          ? 'policy declined to retry and the order was closed -- no money spent chasing a dead card'
          : 'policy chose to retry a hard decline -- guardrail is broken',
      ...(await invariantState()),
    };
  });

  app.get('/history', async () => ({
    events: await q(`SELECT * FROM chaos_events ORDER BY id DESC LIMIT 40`),
  }));
}

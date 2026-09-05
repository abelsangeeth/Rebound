import type { FastifyInstance } from 'fastify';
import { q, one } from '../core/db.js';
import { railScores } from '../core/rails.js';
import { stats, queueDepth, resetStats } from '../core/worker.js';
import { clock } from '../sim/clock.js';
import { startTraffic, stopTraffic, trafficRunning, spawnOrder } from '../sim/generator.js';
import { reconcile, planNext, runAttempt, buildFeatures } from '../core/recovery.js';
import { runExperiment } from '../sim/experiment.js';
import { flushSchedule } from '../core/redis.js';

export default async function registerApi(app: FastifyInstance) {
  /**
   * The headline numbers.
   *
   * `ceiling` is the part you cannot compute on real traffic: the value of
   * every order that was genuinely recoverable, known because the simulator
   * planted it. Recovered-over-ceiling is therefore a true score out of a
   * true maximum, not a rate you can flatter by retrying more.
   */
  app.get('/metrics', async () => {
    const m = await one<any>(`
      WITH f AS (
        SELECT o.id, o.amount_paise, o.status, o.sim_recoverable, o.sim_cohort,
               (SELECT COUNT(*) FROM payment_attempts pa WHERE pa.order_id = o.id) AS attempts,
               -- Only attempt 2 and beyond count as waste. The first attempt on
               -- a dead card is unavoidable: you cannot know an instrument is
               -- dead until it declines once. Counting it would make a perfect
               -- policy look 40% wasteful and the number would mean nothing.
               (SELECT COUNT(*) FROM payment_attempts pa
                 WHERE pa.order_id = o.id AND pa.attempt_no > 1) AS retries,
               -- first_failed_at, NOT "has a failed attempt".
               --
               -- Reconciliation rewrites an ambiguous attempt from 'unknown'
               -- to 'succeeded' once the provider confirms the capture, which
               -- erases the only trace that the order ever needed recovering.
               -- Keying off attempt status therefore drops every ghost-charge
               -- recovery from BOTH the numerator and the denominator, and an
               -- entire cohort reads as 0% recovered when it is not. The order
               -- column is set once, when recovery starts, and survives.
               (o.first_failed_at IS NOT NULL) AS failed_once
          FROM orders o
      )
      SELECT
        COUNT(*)::int                                                        AS orders,
        COUNT(*) FILTER (WHERE failed_once)::int                             AS at_risk,
        COALESCE(SUM(amount_paise) FILTER (WHERE failed_once),0)::bigint     AS at_risk_value,
        COUNT(*) FILTER (WHERE failed_once AND status='paid')::int           AS recovered,
        COALESCE(SUM(amount_paise) FILTER (WHERE failed_once AND status='paid'),0)::bigint
                                                                             AS recovered_value,
        COUNT(*) FILTER (WHERE failed_once AND sim_recoverable)::int         AS ceiling_count,
        COALESCE(SUM(amount_paise) FILTER (WHERE failed_once AND sim_recoverable),0)::bigint
                                                                             AS ceiling_value,
        COALESCE(SUM(retries) FILTER (WHERE NOT sim_recoverable),0)::int     AS wasted_retries,
        COALESCE(SUM(retries),0)::int                                        AS total_retries,
        COALESCE(SUM(attempts),0)::int                                       AS total_attempts,
        COUNT(*) FILTER (WHERE status='abandoned')::int                      AS abandoned
      FROM f`);

    const ledger = await one<any>(`
      SELECT
        COALESCE(SUM(amount_paise) FILTER (WHERE account='merchant_payable' AND direction='credit'),0)::bigint AS payable,
        COALESCE(SUM(amount_paise) FILTER (WHERE account='fee_expense'),0)::bigint AS fees,
        COUNT(DISTINCT entry_group)::int AS groups
      FROM ledger_entries`);

    const wh = await one<any>(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE duplicate_of IS NOT NULL)::int AS duplicates,
             COUNT(*) FILTER (WHERE NOT signature_ok)::int AS rejected
        FROM webhook_events`);

    const capture = m.ceiling_value > 0 ? m.recovered_value / m.ceiling_value : 0;
    return {
      ...m,
      capture_of_ceiling: Number(capture.toFixed(4)),
      ledger,
      webhooks: wh,
      worker: { ...stats, queued: await queueDepth() },
      clock: { virtualNow: clock.now(), speed: clock.speed },
    };
  });

  app.get('/invariants', async () => {
    const rows = await q(`SELECT name, statement, ok, observed FROM invariants ORDER BY name`);
    return { all_ok: rows.every((r: any) => r.ok), invariants: rows };
  });

  app.get('/rails', async () => ({ rails: await railScores() }));

  app.get('/cohorts', async () => ({
    cohorts: await q(`
      SELECT o.sim_cohort AS cohort,
             COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE o.status='paid')::int AS recovered,
             bool_or(o.sim_recoverable) AS recoverable,
             ROUND(AVG((SELECT COUNT(*) FROM payment_attempts pa WHERE pa.order_id=o.id)),2) AS avg_attempts
        FROM orders o
       WHERE o.first_failed_at IS NOT NULL
       GROUP BY o.sim_cohort ORDER BY n DESC`),
  }));
  app.get('/orders', async (req) => {
    const { status, limit } = req.query as { status?: string; limit?: string };
    const rows = await q(
      `SELECT o.id, o.merchant_id, o.customer_id, o.amount_paise, o.status,
              o.sim_cohort, o.sim_recoverable, o.original_rail, o.created_at, o.paid_at,
              (SELECT COUNT(*) FROM payment_attempts pa WHERE pa.order_id=o.id)::int AS attempts,
              (SELECT pa.error_reason FROM payment_attempts pa
                WHERE pa.order_id=o.id AND pa.error_reason IS NOT NULL
                ORDER BY pa.attempt_no DESC LIMIT 1) AS last_reason,
              (SELECT pa.decline_class FROM payment_attempts pa
                WHERE pa.order_id=o.id AND pa.decline_class IS NOT NULL
                ORDER BY pa.attempt_no DESC LIMIT 1) AS decline_class
         FROM orders o
        WHERE ($1::text IS NULL OR o.status = $1)
          AND o.first_failed_at IS NOT NULL
        ORDER BY o.created_at DESC
        LIMIT $2`,
      [status ?? null, Math.min(Number(limit ?? 40), 200)],
    );
    return { orders: rows };
  });

  /** Everything that happened to one order: attempts, decisions and the
   *  reasoning behind each. This is the "why did you retry that?" answer. */
  app.get('/orders/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const order = await one(`SELECT * FROM orders WHERE id=$1`, [id]);
    if (!order) return reply.code(404).send({ error: 'not found' });
    const [attempts, decisions, ledger, nudges] = await Promise.all([
      q(`SELECT * FROM payment_attempts WHERE order_id=$1 ORDER BY attempt_no`, [id]),
      q(`SELECT * FROM decisions WHERE order_id=$1 ORDER BY created_at`, [id]),
      q(`SELECT * FROM ledger_entries WHERE order_id=$1 ORDER BY id`, [id]),
      q(`SELECT * FROM nudges WHERE order_id=$1 ORDER BY sent_at`, [id]),
    ]);
    return { order, attempts, decisions, ledger, nudges };
  });

  app.get('/decisions', async (req) => {
    const { limit } = req.query as { limit?: string };
    return {
      decisions: await q(
        `SELECT d.*, o.amount_paise, o.sim_cohort
           FROM decisions d JOIN orders o ON o.id=d.order_id
          ORDER BY d.created_at DESC LIMIT $1`,
        [Math.min(Number(limit ?? 25), 100)],
      ),
    };
  });

  // --- simulator controls -------------------------------------------------
  app.get('/sim/status', async () => ({
    running: trafficRunning(),
    speed: clock.speed,
    virtualNow: clock.now(),
    queued: await queueDepth(),
  }));

  app.post('/sim/start', async (req) => {
    const { rate, speed } = (req.body ?? {}) as { rate?: number; speed?: number };
    if (speed) clock.setSpeed(speed);
    startTraffic(rate ?? 4);
    return { ok: true, running: true, rate: rate ?? 4, speed: clock.speed };
  });

  app.post('/sim/stop', async () => {
    stopTraffic();
    return { ok: true, running: false };
  });

  app.post('/sim/speed', async (req) => {
    const { speed } = req.body as { speed: number };
    clock.setSpeed(speed);
    return { ok: true, speed: clock.speed };
  });

  /**
   * Wipe the transactional tables and the queue.
   *
   * Demo-only, and it says so: recording a walkthrough against a half-drained
   * queue or a database still holding a previous run's chaos orders makes the
   * headline numbers look arbitrary. Training samples are deliberately spared
   * -- they are expensive to regenerate and are not transactional state.
   */
  app.post('/sim/reset', async () => {
    stopTraffic();
    await q(`TRUNCATE orders, payment_attempts, decisions, ledger_entries,
                      webhook_events, nudges, chaos_events, rail_health
             RESTART IDENTITY CASCADE`);
    await flushSchedule();
    clock.reset();
    resetStats();
    return { ok: true, reset: true };
  });

  app.post('/sim/burst', async (req) => {
    const { n, seed } = (req.body ?? {}) as { n?: number; seed?: number };
    const count = Math.min(Number(n ?? 25), 400);
    const out = [];
    for (let i = 0; i < count; i++) {
      // A seed makes the POPULATION reproducible -- same cohort mix, same
      // amounts, same entry rails. Outcomes still vary a little because
      // reconciliation timing is wall-clock dependent, but the run-to-run
      // swing drops from tens of points to a couple.
      out.push(await spawnOrder(seed != null ? Number(seed) + i : undefined));
    }
    return { ok: true, spawned: out.length, seeded: seed != null };
  });

  /** Model card, proxied from the decision service so the dashboard has one
   *  origin to talk to. Degrades to a clear "not trained" rather than an
   *  error when the ML service is down -- the money path does not depend on
   *  it, and the UI should say so. */
  app.get('/model', async () => {
    try {
      const r = await fetch(`${process.env.DECISION_URL ?? 'http://localhost:8000'}/metrics`, {
        signal: AbortSignal.timeout(2500),
      });
      if (!r.ok) return { metrics: null, importance: [] };
      return await r.json();
    } catch {
      return { metrics: null, importance: [], note: 'decision service unreachable' };
    }
  });

  /**
   * Counterfactual A/B against the same seeded population.
   *
   * Runs entirely in memory -- it writes nothing and does not disturb the live
   * metrics. Deterministic for a given seed, so the same experiment can be
   * re-run and audited.
   */
  app.post('/experiment', async (req) => {
    const { n, seed } = (req.body ?? {}) as { n?: number; seed?: number };
    const count = Math.min(Math.max(Number(n ?? 800), 50), 4000);
    const s = Number(seed ?? 20260902);
    const started = Date.now();
    const out = await runExperiment(count, s);
    return { ...out, took_ms: Date.now() - started };
  });

  /** SHAP attribution for one order's next decision -- the "why this rail,
   *  why this delay" answer, straight from the model that made the call. */
  app.get('/orders/:id/why', async (req, reply) => {
    const { id } = req.params as { id: string };
    const order = await one<any>(`SELECT * FROM orders WHERE id=$1`, [id]);
    if (!order) return reply.code(404).send({ error: 'not found' });
    const last = await one<any>(
      `SELECT * FROM payment_attempts WHERE order_id=$1 ORDER BY attempt_no DESC LIMIT 1`,
      [id],
    );
    if (!last) return { shap: [], note: 'no attempts yet' };

    const attempts = await q<any>(
      `SELECT COUNT(*)::int AS n, COUNT(DISTINCT rail)::int AS rails
         FROM payment_attempts WHERE order_id=$1`,
      [id],
    );
    const features = buildFeatures(
      order,
      last,
      last.rail,
      attempts[0]?.n ?? 1,
      attempts[0]?.rails ?? 1,
      clock.now(),
    );

    try {
      const r = await fetch(`${process.env.DECISION_URL ?? 'http://localhost:8000'}/explain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ features: { ...features, delay_hours: 24 } }),
        signal: AbortSignal.timeout(4000),
      });
      if (!r.ok) return { shap: [], note: 'decision service error' };
      return { ...(await r.json()), features };
    } catch {
      return { shap: [], note: 'decision service unreachable' };
    }
  });

  app.get('/chaos-history', async () => ({
    events: await q(`SELECT id, kind, detail, created_at FROM chaos_events ORDER BY id DESC LIMIT 30`),
  }));
}

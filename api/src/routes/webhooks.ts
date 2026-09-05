import type { FastifyInstance } from 'fastify';
import { verifyWebhook } from '../core/razorpay.js';
import { q, one, isUniqueViolation } from '../core/db.js';
import { acquireOnce } from '../core/redis.js';
import { settle, planNext, markFailed, type AttemptRow } from '../core/recovery.js';
import { classify } from '../core/taxonomy.js';

export default async function registerWebhooks(app: FastifyInstance) {
  /**
   * Razorpay delivers AT LEAST ONCE. Duplicates, retries and out-of-order
   * arrivals are normal operation, not faults. So:
   *
   *   1. verify the signature over the raw bytes, BEFORE parsing anything
   *   2. insert the provider's event id under a UNIQUE constraint
   *   3. if that insert loses, this is a replay -- ack 200 and do nothing
   *
   * Acking a duplicate with 200 is deliberate. Any non-2xx makes Razorpay
   * redeliver, and redelivering an event we already applied is precisely the
   * loop we are trying to avoid.
   */
  app.post('/webhooks/razorpay', async (req, reply) => {
    const raw = ((req as any).rawBody as Buffer) ?? Buffer.alloc(0);
    const sig = req.headers['x-razorpay-signature'] as string | undefined;

    if (!verifyWebhook(raw, sig)) {
      await q(
        `INSERT INTO webhook_events (provider_event_id, event_type, signature_ok, payload)
         VALUES ($1,'rejected',false,$2) ON CONFLICT DO NOTHING`,
        [`bad_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, JSON.stringify({ raw: raw.toString().slice(0, 1000) })],
      ).catch(() => {});
      return reply.code(401).send({ error: 'signature verification failed' });
    }

    const body = req.body as any;
    const eventId =
      (req.headers['x-razorpay-event-id'] as string) ?? body?.id ?? `evt_${Date.now()}`;

    try {
      await q(
        `INSERT INTO webhook_events (provider_event_id, event_type, signature_ok, payload)
         VALUES ($1,$2,true,$3)`,
        [eventId, body?.event ?? 'unknown', JSON.stringify(body ?? {})],
      );
    } catch (e) {
      if (isUniqueViolation(e)) {
        await q(`UPDATE webhook_events SET duplicate_of=$1 WHERE provider_event_id=$1`, [eventId]);
        return reply.code(200).send({ ok: true, duplicate: true });
      }
      throw e;
    }

    // Second guard, for two deliveries arriving close enough together that
    // both pass the insert before either commits.
    if (!(await acquireOnce(eventId))) return reply.code(200).send({ ok: true, inflight: true });

    await applyEvent(body);
    await q(`UPDATE webhook_events SET processed_at=now() WHERE provider_event_id=$1`, [eventId]);
    return reply.code(200).send({ ok: true });
  });
}

/** Map a Razorpay event onto our state machine. The order id travels in
 *  notes.rebound_order, set when the order was created. */
async function applyEvent(body: any) {
  const event: string = body?.event ?? '';
  const pay = body?.payload?.payment?.entity;
  if (!pay) return;

  const orderId: string | undefined = pay?.notes?.rebound_order ?? pay?.order_id;
  if (!orderId) return;

  const att = await one<AttemptRow>(
    `SELECT * FROM payment_attempts
      WHERE order_id=$1 ORDER BY attempt_no DESC LIMIT 1`,
    [orderId],
  );
  if (!att) return;

  if (event === 'payment.captured' || event === 'order.paid') {
    await settle(att.id, orderId, pay.id);
    return;
  }

  if (event === 'payment.failed') {
    const sig = {
      error_code: pay.error_code,
      error_reason: pay.error_reason,
      error_source: pay.error_source,
      error_step: pay.error_step,
      error_description: pay.error_description,
    };
    await markFailed(att.id, { ...sig, status: 'failed' }, classify(sig));
    await planNext(orderId);
  }
}

import { createHmac, timingSafeEqual } from 'node:crypto';
import { env, haveRazorpay } from './env.js';

/**
 * Verify a Razorpay webhook.
 *
 * Two things matter here and both are easy to get wrong:
 *  1. The HMAC is over the RAW request body. Parse-then-restringify changes
 *     key order and whitespace and the signature stops matching. Fastify is
 *     configured to hand us the untouched Buffer.
 *  2. The comparison is constant-time. A plain === leaks the signature one
 *     byte at a time to anyone willing to measure.
 */
export function verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature || !env.razorpayWebhookSecret) return false;
  const expected = createHmac('sha256', env.razorpayWebhookSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Verify a Checkout handler payload: HMAC over "order_id|payment_id". */
export function verifyPaymentSignature(
  razorpayOrderId: string,
  razorpayPaymentId: string,
  signature: string,
): boolean {
  if (!env.razorpayKeySecret) return false;
  const expected = createHmac('sha256', env.razorpayKeySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const authHeader = () =>
  'Basic ' + Buffer.from(`${env.razorpayKeyId}:${env.razorpayKeySecret}`).toString('base64');

async function rzp(path: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`razorpay ${path} ${res.status}: ${JSON.stringify(body)}`);
  return body as any;
}

export const razorpay = {
  live: haveRazorpay,

  createOrder: (amountPaise: number, receipt: string, notes: Record<string, string> = {}) =>
    rzp('/orders', {
      method: 'POST',
      body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt, notes }),
    }),

  fetchPayment: (paymentId: string) => rzp(`/payments/${paymentId}`),

  /**
   * The reconciliation call that resolves an ambiguous attempt. Given an
   * order, ask Razorpay what it actually has. This is the ONLY correct way
   * out of a timeout -- never a retry, never a guess.
   */
  fetchPaymentsForOrder: (orderId: string) => rzp(`/orders/${orderId}/payments`),

  createPaymentLink: (amountPaise: number, description: string, notes: Record<string, string>) =>
    rzp('/payment_links', {
      method: 'POST',
      body: JSON.stringify({
        amount: amountPaise,
        currency: 'INR',
        description,
        notes,
        reminder_enable: false,
      }),
    }),

  refund: (paymentId: string, amountPaise: number, idemKey: string) =>
    rzp(`/payments/${paymentId}/refund`, {
      method: 'POST',
      headers: { 'X-Razorpay-Idempotency-Key': idemKey },
      body: JSON.stringify({ amount: amountPaise, speed: 'optimum' }),
    }),
};

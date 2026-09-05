import type { FastifyInstance } from 'fastify';
import { q, one } from '../core/db.js';
import { env } from '../core/env.js';
import { humanDelay } from '../core/policy.js';

// Customer-facing copy, written by Claude.
//
// THE BOUNDARY: this module receives a decision that has already been made and
// turns it into a sentence. It cannot retry a payment, cannot change a rail,
// cannot move an amount. There is no code path from a model output to a debit.
// That separation is what makes it safe to let a language model near a
// payments system at all, and it is deliberate rather than incidental.

const RUPEES = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

/** Deterministic fallbacks. The product works with no API key -- the model
 *  improves the copy, it is not load-bearing. */
function template(reason: string, amountPaise: number, rail: string, lang: string): string {
  const amt = RUPEES(amountPaise);
  const t: Record<string, Record<string, string>> = {
    insufficient_funds: {
      en: `Your ${amt} payment did not go through -- your bank reported insufficient balance. Nothing has been charged. Tap to pay when you are ready.`,
      hi: `Aapka ${amt} ka payment nahi ho paaya -- bank ne balance kam bataya. Koi paisa nahi kata hai. Taiyaar hon to pay kijiye.`,
      hinglish: `Your ${amt} payment failed -- bank ne insufficient balance bataya. Kuch charge nahi hua. Ready ho to ek tap mein pay karo.`,
    },
    issuer_down: {
      en: `Your bank was temporarily unreachable, so your ${amt} payment did not complete. Nothing was charged. We will try again shortly.`,
      hi: `Aapka bank thodi der ke liye uplabdh nahi tha, isliye ${amt} ka payment poora nahi hua. Kuch charge nahi hua.`,
      hinglish: `Bank temporarily down tha, isliye ${amt} ka payment complete nahi hua. Nothing charged -- hum thodi der mein try karenge.`,
    },
    payment_limit_exceeded: {
      en: `Your ${amt} payment crossed your bank's per-transaction limit. Nothing was charged. You can split it into EMI or pay by UPI instead.`,
      hi: `${amt} ka payment aapke bank ki limit se zyada tha. Kuch charge nahi hua. EMI ya UPI se try kijiye.`,
      hinglish: `${amt} ka payment bank limit cross kar gaya. Kuch charge nahi hua -- EMI ya UPI se try karo.`,
    },
    default: {
      en: `Your ${amt} payment did not complete and nothing was charged. Tap to try again on ${rail.replace('_', ' ')}.`,
      hi: `Aapka ${amt} ka payment poora nahi hua aur koi paisa nahi kata. Dobara koshish kijiye.`,
      hinglish: `${amt} ka payment complete nahi hua, kuch charge nahi hua. Try again karo.`,
    },
  };
  return (t[reason] ?? t.default)[lang] ?? (t[reason] ?? t.default).en;
}

const SYSTEM = `You write SMS and WhatsApp copy for an Indian payments recovery product.

Hard rules:
- Under 160 characters. One clear next step.
- ALWAYS state plainly that no money was taken, when that is true. This is the single most reassuring fact and customers do not know it.
- Never invent a discount, a deadline, a penalty or an offer.
- Never blame the customer. A declined card is not a character flaw.
- Never say "failed transaction" twice; say what happened in the bank's terms, simply.
- Match the requested language exactly. Hinglish means Roman script, Hindi words mixed with English -- the way people actually text, not translated English.
- Return ONLY the message text. No preamble, no quotes, no explanation.`;

async function claudeCopy(prompt: string): Promise<string | null> {
  if (!env.anthropicKey) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 300,
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as any;
    return j?.content?.[0]?.text?.trim() ?? null;
  } catch {
    return null;
  }
}

export default async function registerNudge(app: FastifyInstance) {
  app.post('/nudge/:orderId', async (req, reply) => {
    const { orderId } = req.params as { orderId: string };
    const { language = 'hinglish', channel = 'sms' } = (req.body ?? {}) as {
      language?: string;
      channel?: string;
    };

    const order = await one<any>(`SELECT * FROM orders WHERE id=$1`, [orderId]);
    if (!order) return reply.code(404).send({ error: 'not found' });

    const last = await one<any>(
      `SELECT * FROM payment_attempts WHERE order_id=$1 ORDER BY attempt_no DESC LIMIT 1`,
      [orderId],
    );
    const decision = await one<any>(
      `SELECT * FROM decisions WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [orderId],
    );

    const reason = last?.error_reason ?? 'unknown';
    const prompt = `Payment context:
- amount: ${RUPEES(Number(order.amount_paise))}
- what the bank said: ${reason} (source: ${last?.error_source ?? 'unknown'})
- money actually taken: no
- what happens next: ${
      decision?.should_retry
        ? `we will retry automatically on ${decision.rail} in about ${humanDelay(decision.delay_seconds)}`
        : 'we are not retrying automatically; the customer decides'
    }
- language: ${language}
- channel: ${channel}

Write the message.`;

    const generated = await claudeCopy(prompt);
    const body = generated ?? template(reason, Number(order.amount_paise), last?.rail ?? 'upi', language);

    await q(
      `INSERT INTO nudges (order_id, channel, language, body, generator) VALUES ($1,$2,$3,$4,$5)`,
      [orderId, channel, language, body, generated ? 'claude-sonnet-5' : 'template'],
    );

    return {
      ok: true,
      order_id: orderId,
      language,
      channel,
      body,
      generator: generated ? 'claude-sonnet-5' : 'template (no ANTHROPIC_API_KEY set)',
      note: 'copy only -- this endpoint cannot start, schedule or change a payment',
    };
  });

  /** Turn a raw decline into something a merchant ops person can act on. */
  app.post('/explain/:orderId', async (req, reply) => {
    const { orderId } = req.params as { orderId: string };
    const order = await one<any>(`SELECT * FROM orders WHERE id=$1`, [orderId]);
    if (!order) return reply.code(404).send({ error: 'not found' });

    const attempts = await q<any>(
      `SELECT attempt_no, rail, status, error_reason, error_source, decline_class
         FROM payment_attempts WHERE order_id=$1 ORDER BY attempt_no`,
      [orderId],
    );
    const decisions = await q<any>(
      `SELECT after_attempt, should_retry, delay_seconds, rail, p_success, reasons
         FROM decisions WHERE order_id=$1 ORDER BY created_at`,
      [orderId],
    );

    const text = await claudeCopy(
      `Explain to a merchant operations analyst, in three sentences, what happened to this payment and whether anything needs a human. Be concrete and do not hedge.

Order: ${RUPEES(Number(order.amount_paise))}, status ${order.status}
Attempts: ${JSON.stringify(attempts)}
Decisions: ${JSON.stringify(decisions)}

Respond with the explanation only.`,
    );

    return {
      ok: true,
      order_id: orderId,
      explanation:
        text ??
        `${attempts.length} attempt(s). Last decline: ${
          attempts[attempts.length - 1]?.error_reason ?? 'n/a'
        } (${attempts[attempts.length - 1]?.decline_class ?? 'n/a'}). Order is ${order.status}.` +
          ` Set ANTHROPIC_API_KEY for the written explanation.`,
      attempts,
      decisions,
    };
  });
}

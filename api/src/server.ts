import Fastify from 'fastify';
import cors from '@fastify/cors';
import { env } from './core/env.js';
import { pool } from './core/db.js';
import { redis } from './core/redis.js';
import { startWorker, hydrateClock } from './core/worker.js';
import registerWebhooks from './routes/webhooks.js';
import registerApi from './routes/api.js';
import registerChaos from './routes/chaos.js';
import registerNudge from './routes/nudge.js';

const app = Fastify({ logger: { level: 'warn' } });

await app.register(cors, { origin: true });

/**
 * Keep the raw body alongside the parsed one.
 *
 * Razorpay signs the exact bytes it sent. Parsing to an object and
 * re-serialising changes key order and whitespace, and the HMAC no longer
 * matches -- a failure that looks like a wrong secret and is not. So we hold
 * on to the original buffer and verify against that.
 */
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
  (req as any).rawBody = body as Buffer;
  try {
    done(null, (body as Buffer).length ? JSON.parse(body.toString()) : {});
  } catch (e) {
    done(e as Error, undefined);
  }
});

app.get('/health', async () => {
  const db = await pool.query('SELECT 1').then(() => true).catch(() => false);
  const rd = await redis.ping().then(() => true).catch(() => false);
  return { ok: db && rd, db, redis: rd, razorpay: Boolean(env.razorpayKeyId) };
});

await app.register(registerWebhooks);
await app.register(registerApi, { prefix: '/api' });
await app.register(registerChaos, { prefix: '/api/chaos' });
await app.register(registerNudge, { prefix: '/api' });

// Resume virtual time first, otherwise the worker starts draining against
// a clock that has silently rewound to real time.
await hydrateClock();
startWorker(200);

await app.listen({ port: env.port, host: '0.0.0.0' });
console.log(`\n  rebound api    http://localhost:${env.port}`);
console.log(`  webhook        POST /webhooks/razorpay`);
console.log(`  razorpay keys  ${env.razorpayKeyId ? 'loaded' : 'not set (simulator only)'}`);
console.log(`  anthropic key  ${env.anthropicKey ? 'loaded' : 'not set (template nudges)'}\n`);

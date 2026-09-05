import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Tiny .env loader. Avoids a dependency and makes the load order explicit:
// real process env always wins over the file.
const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, '../../../.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const [, k, raw] = m;
    if (process.env[k] === undefined) process.env[k] = raw.replace(/^["']|["']$/g, '');
  }
}

export const env = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://rebound:rebound@localhost:55432/rebound',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:56379',
  decisionUrl: process.env.DECISION_URL ?? 'http://localhost:8000',
  port: Number(process.env.PORT ?? 3000),
  razorpayKeyId: process.env.RAZORPAY_KEY_ID ?? '',
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET ?? '',
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ?? '',
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? '',
};

export const haveRazorpay = () => Boolean(env.razorpayKeyId && env.razorpayKeySecret);

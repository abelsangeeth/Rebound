import Redis from 'ioredis';
import { env } from './env.js';

export const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });

export const RETRY_ZSET = 'rebound:retries';
export const BANDIT_KEY = 'rebound:bandit';
export const BREAKER_KEY = 'rebound:breaker';

/**
 * Claim a due retry.
 *
 * ZPOPMIN alone would let two workers pop different members concurrently but
 * cannot express "only if due", and a ZRANGEBYSCORE + ZREM pair is a race:
 * two workers read the same member and both act on it. This Lua script makes
 * read-check-remove one atomic step, so exactly one worker ever gets a given
 * retry token no matter how many are running.
 */
const CLAIM_DUE = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
if #due == 0 then return {} end
for i = 1, #due do redis.call('ZREM', KEYS[1], due[i]) end
return due
`;

export async function claimDueRetries(nowMs: number, limit = 25): Promise<string[]> {
  const res = (await redis.eval(CLAIM_DUE, 1, RETRY_ZSET, String(nowMs), String(limit))) as string[];
  return res ?? [];
}

export async function scheduleRetry(token: string, dueAtMs: number) {
  await redis.zadd(RETRY_ZSET, dueAtMs, token);
}

export async function pendingRetries(): Promise<number> {
  return redis.zcard(RETRY_ZSET);
}

/** Drop every scheduled retry and the webhook dedupe keys. Demo reset only --
 *  the durable dedupe lives in Postgres, so clearing these loses no guarantee. */
export async function flushSchedule(): Promise<void> {
  await redis.del(RETRY_ZSET);
  const keys = await redis.keys('rebound:once:*');
  if (keys.length) await redis.del(...keys);
  await redis.del('rebound:clock:virtual');
}

/**
 * Idempotency guard for webhook processing. Postgres holds the durable
 * dedupe (unique on provider_event_id); this is the cheap first line that
 * stops two concurrent deliveries of the same event from both starting work.
 */
export async function acquireOnce(key: string, ttlSeconds = 900): Promise<boolean> {
  const r = await redis.set(`rebound:once:${key}`, '1', 'EX', ttlSeconds, 'NX');
  return r === 'OK';
}

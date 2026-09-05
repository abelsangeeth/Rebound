import { claimDueRetries, pendingRetries, redis } from './redis.js';
import { runAttempt, reconcile } from './recovery.js';
import { clock } from '../sim/clock.js';

// Drains the schedule. Claims are atomic (see redis.ts), so running several
// of these changes throughput and nothing else -- no token is ever handled
// twice, and the attempt table's unique constraint would catch it if one were.

export interface WorkerStats {
  processed: number;
  retries: number;
  reconciles: number;
  blocked: number;
  errors: number;
  lastTick: number;
}

export const stats: WorkerStats = {
  processed: 0, retries: 0, reconciles: 0, blocked: 0, errors: 0, lastTick: 0,
};

/** Zero the counters in place. Demo reset only -- the object identity is kept
 *  because the metrics route spreads this live reference. */
export function resetStats(): void {
  stats.processed = 0; stats.retries = 0; stats.reconciles = 0;
  stats.blocked = 0; stats.errors = 0; stats.lastTick = 0;
}

let running = false;
let timer: NodeJS.Timeout | null = null;

async function tick() {
  stats.lastTick = Date.now();
  let due: string[] = [];
  try {
    due = await claimDueRetries(clock.now(), 40);
  } catch {
    stats.errors++;
    return;
  }

  for (const token of due) {
    const parts = token.split('|');
    try {
      if (parts[0] === 'retry') {
        const [, orderId, n, rail] = parts;
        const r: any = await runAttempt(orderId, Number(n), rail);
        stats.retries++;
        if (r?.reason === 'blocked_ambiguous') stats.blocked++;
      } else if (parts[0] === 'recon') {
        const [, orderId, n] = parts;
        await reconcile(orderId, Number(n));
        stats.reconciles++;
      }
      stats.processed++;
    } catch (e) {
      stats.errors++;
      console.error('[worker]', token, (e as Error).message);
    }
  }
}

export const CLOCK_KEY = 'rebound:clock:virtual';

/** Restore virtual time from the last run before processing anything, so
 *  retries scheduled at fast-forwarded timestamps are not stranded. */
export async function hydrateClock() {
  const saved = await redis.get(CLOCK_KEY).catch(() => null);
  if (saved) clock.hydrate(Number(saved));
}

export function startWorker(intervalMs = 200) {
  if (running) return;
  running = true;
  let sinceSave = 0;
  const loop = async () => {
    await tick().catch(() => { stats.errors++; });
    // Checkpoint virtual time roughly every 2s of real time.
    if (++sinceSave * intervalMs >= 2000) {
      sinceSave = 0;
      redis.set(CLOCK_KEY, String(clock.now())).catch(() => {});
    }
    if (running) timer = setTimeout(loop, intervalMs);
  };
  loop();
}

export function stopWorker() {
  running = false;
  if (timer) clearTimeout(timer);
}

export const queueDepth = pendingRetries;

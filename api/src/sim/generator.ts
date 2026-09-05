import { createOrder, runAttempt, RAILS } from '../core/recovery.js';
import { newSimState, mulberry32 } from './gateway.js';
import { clock } from './clock.js';

// Traffic generator. Produces the checkout stream the recovery engine feeds on.

const MERCHANTS = ['mrc_kirana', 'mrc_edtech', 'mrc_saas', 'mrc_travel'];
const ENTRY_RAILS = ['upi', 'upi', 'upi', 'card', 'card', 'netbanking', 'wallet'];

let seq = 1;

/** Ticket sizes shaped like real Indian checkout: mostly small, a long tail. */
function amountFor(rnd: () => number): number {
  const r = rnd();
  if (r < 0.55) return Math.round((150 + rnd() * 900) * 100);
  if (r < 0.85) return Math.round((1000 + rnd() * 4000) * 100);
  return Math.round((5000 + rnd() * 25000) * 100);
}

export async function spawnOrder(seed?: number) {
  const s = seed ?? Date.now() + seq++;
  const rnd = mulberry32(s);
  const st = newSimState(rnd);
  const rail = ENTRY_RAILS[Math.floor(rnd() * ENTRY_RAILS.length)];
  const orderId = await createOrder({
    merchantId: MERCHANTS[Math.floor(rnd() * MERCHANTS.length)],
    customerId: `cust_${Math.floor(rnd() * 4000).toString(36)}`,
    amountPaise: amountFor(rnd),
    rail,
    simState: st,
    createdAt: clock.date(),
  });
  const res = await runAttempt(orderId, 1, rail);
  return { orderId, cohort: st.cohort, rail, res };
}

let genTimer: NodeJS.Timeout | null = null;

export function startTraffic(ordersPerSecond = 3) {
  stopTraffic();
  const gap = Math.max(20, Math.floor(1000 / ordersPerSecond));
  genTimer = setInterval(() => {
    spawnOrder().catch((e) => console.error('[gen]', e.message));
  }, gap);
}

export function stopTraffic() {
  if (genTimer) clearInterval(genTimer);
  genTimer = null;
}

export const trafficRunning = () => genTimer !== null;

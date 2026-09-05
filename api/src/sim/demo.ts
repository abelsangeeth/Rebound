/**
 * Seed a settled demo dataset.
 *
 *     npm run demo [orders]
 *
 * Resets the transactional tables, generates a population of orders from a
 * fixed seed, then runs the virtual clock fast until the retry schedule is
 * genuinely finished -- so the dashboard shows numbers that have converged
 * rather than a half-drained queue climbing while you look at it.
 *
 * Traffic is left PAUSED at the end. Starting it is a deliberate action, not
 * something that should happen behind your back.
 */
import { pathToFileURL } from 'node:url';

const API = process.env.API_URL ?? 'http://localhost:3000';
const ORDERS = Number(process.argv[2] ?? 600);
// Fixed seed: same cohort mix, amounts and entry rails every run, so the
// headline number does not swing by fifteen points between takes.
const SEED = Number(process.env.DEMO_SEED ?? 20260905);

const post = (path: string, body?: unknown) =>
  fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json() as Promise<any>);

const get = (path: string) => fetch(`${API}${path}`).then((r) => r.json() as Promise<any>);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rupees = (p: number) => `Rs ${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

async function main() {
  try {
    await get('/health');
  } catch {
    console.error(`\n  cannot reach the API at ${API}\n  start it first:  cd api && npm start\n`);
    process.exit(1);
  }

  console.log('\n  preparing demo state\n');

  process.stdout.write('  resetting            ');
  await post('/api/sim/reset');
  console.log('done');

  process.stdout.write(`  generating ${ORDERS} orders `);
  // Chunked: one enormous burst makes the first tick do all the work and the
  // queue depth spike looks like a bug rather than a backlog.
  for (let i = 0; i < ORDERS; i += 200) {
    await post('/api/sim/burst', { n: Math.min(200, ORDERS - i), seed: SEED + i });
    process.stdout.write('.');
  }
  console.log(' done');

  // 1s = 6 virtual hours. Fast enough to finish a 5-day retry horizon in about
  // half a minute, slow enough that the worker is not starved.
  await post('/api/sim/speed', { speed: 21600 });
  process.stdout.write('  draining schedule    ');

  let quiet = 0;
  for (let i = 0; i < 300; i++) {
    await sleep(1000);
    const m = await get('/api/metrics');
    const queued = m.worker?.queued ?? 0;
    // Two consecutive empty polls, so a momentary gap between a reconcile
    // being scheduled and it landing is not mistaken for completion.
    quiet = queued === 0 ? quiet + 1 : 0;
    if (i % 5 === 0) process.stdout.write('.');
    if (quiet >= 2) break;
  }
  console.log(' done');

  await post('/api/sim/stop');
  await post('/api/sim/speed', { speed: 3600 });

  const m = await get('/api/metrics');
  const inv = await get('/api/invariants');
  const cohorts = await get('/api/cohorts');

  console.log('\n  ready to record\n');
  console.log(`    captured of ceiling   ${(m.capture_of_ceiling * 100).toFixed(1)}%`);
  console.log(`    recovered             ${m.recovered} orders (${rupees(m.recovered_value)})`);
  console.log(`    true ceiling          ${m.ceiling_count} orders (${rupees(m.ceiling_value)})`);
  console.log(`    wasted retries        ${m.wasted_retries}/${m.total_retries}`);
  console.log(`    ledger                ${m.ledger.groups} balanced groups`);
  console.log(`    invariants            ${inv.all_ok ? 'all holding' : 'VIOLATION'}`);
  console.log(`    worker errors         ${m.worker.errors}`);
  console.log('\n    by cohort');
  for (const c of cohorts.cohorts ?? []) {
    const rate = c.n ? ((c.recovered / c.n) * 100).toFixed(0) : '0';
    console.log(
      `      ${c.cohort.padEnd(17)} ${c.recoverable ? 'winnable' : 'dead    '} ${String(c.n).padStart(4)} -> ${String(c.recovered).padStart(4)}  ${rate.padStart(3)}%`,
    );
  }

  const warn: string[] = [];
  if (!inv.all_ok) warn.push('an invariant is failing');
  if (m.worker.errors > 0) warn.push(`${m.worker.errors} worker errors`);
  if (m.capture_of_ceiling < 0.6) warn.push(`capture is only ${(m.capture_of_ceiling * 100).toFixed(1)}% -- rerun`);
  if (m.at_risk < 100) warn.push('very few orders needed recovery -- rerun with more');

  if (warn.length) {
    console.log('\n  before you record:');
    for (const w of warn) console.log(`    - ${w}`);
  } else {
    console.log('\n  traffic is paused. Open http://localhost:5173 and follow docs/demo-script.md');
  }
  console.log('');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

/**
 * Training-data explorer.
 *
 * The model has to answer "what is P(success) if I retry on rail R after
 * delay D?" -- a counterfactual. Production traffic can never answer it,
 * because production only ever tries the option the policy already picked, so
 * the log contains no evidence about the roads not taken.
 *
 * So we generate the evidence deliberately: run orders through the same
 * simulated network the live system uses, but choose the retry rail and delay
 * UNIFORMLY AT RANDOM. That gives unbiased coverage of the whole
 * (cohort x rail x delay) grid. This is exactly the job the Thompson sampler
 * does online once the system is live -- this script is its cold-start
 * equivalent.
 *
 * Physics lives in one place (sim/gateway.ts). Both this and the live path
 * call it, so the model can never be trained on a world that differs from the
 * one it is scored in.
 */
import { pathToFileURL } from 'node:url';
import { pool, q } from '../core/db.js';
import {
  newSimState,
  firstFailure,
  attempt as simAttempt,
  mulberry32,
  RECOVERABLE,
} from './gateway.js';
import { classify } from '../core/taxonomy.js';
import { HOUR } from './clock.js';

const ENTRY_RAILS = ['upi', 'upi', 'upi', 'card', 'card', 'netbanking', 'wallet'];
const RETRY_RAILS = ['upi', 'card', 'card_token', 'netbanking', 'wallet', 'emi', 'paylater'];
// Log-spaced, because recovery is scale-free: the difference between 15m and
// 2h matters as much as the difference between 1d and 3d.
const DELAY_HOURS = [0.25, 0.5, 1, 2, 4, 8, 16, 24, 48, 72, 120];

function amountFor(rnd: () => number): number {
  const r = rnd();
  if (r < 0.55) return Math.round((150 + rnd() * 900) * 100);
  if (r < 0.85) return Math.round((1000 + rnd() * 4000) * 100);
  return Math.round((5000 + rnd() * 25000) * 100);
}

interface Sample {
  amount_paise: number;
  attempt_no: number;
  hours_since_first_failure: number;
  delay_hours: number;
  decline_class: string;
  error_reason: string;
  error_source: string;
  original_rail: string;
  candidate_rail: string;
  hour_of_day: number;
  day_of_month: number;
  prior_attempts: number;
  rails_tried: number;
  label: number;
}

export function explore(n: number, seed = 20260901): Sample[] {
  const rnd = mulberry32(seed);
  const out: Sample[] = [];

  for (let i = 0; i < n; i++) {
    const st = newSimState(rnd);
    const originalRail = ENTRY_RAILS[Math.floor(rnd() * ENTRY_RAILS.length)];
    const amount = amountFor(rnd);

    // Spread the first failure across the clock and the month so the model can
    // learn time-of-day and salary-proximity effects rather than memorising a
    // single hour.
    const startMs = Date.UTC(2026, 7, 1 + Math.floor(rnd() * 28), Math.floor(rnd() * 24), 0, 0);
    const first = firstFailure(st.cohort, rnd);
    const cls = classify(first);

    let elapsed = 0;
    let attemptNo = 1;
    const railsSeen = new Set<string>([originalRail]);
    let lastReason = first.error_reason ?? 'unknown';
    let lastSource = first.error_source ?? 'unknown';
    let lastClass = cls;

    // Up to three exploratory retries per order, each with a randomly chosen
    // rail and delay.
    const retries = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < retries; k++) {
      const delayH = DELAY_HOURS[Math.floor(rnd() * DELAY_HOURS.length)];
      const rail = RETRY_RAILS[Math.floor(rnd() * RETRY_RAILS.length)];
      const at = startMs + (elapsed + delayH * HOUR);
      const attemptRnd = mulberry32(st.seed + attemptNo * 7919 + k);
      const res = simAttempt(st, rail, originalRail, elapsed + delayH * HOUR, amount, attemptRnd, at);

      out.push({
        amount_paise: amount,
        attempt_no: attemptNo,
        hours_since_first_failure: Number((elapsed / HOUR).toFixed(3)),
        delay_hours: delayH,
        decline_class: lastClass,
        error_reason: lastReason,
        error_source: lastSource,
        original_rail: originalRail,
        candidate_rail: rail,
        hour_of_day: new Date(at).getUTCHours(),
        day_of_month: new Date(at).getUTCDate(),
        prior_attempts: attemptNo,
        rails_tried: railsSeen.size,
        // An ambiguous outcome is NOT a label. We genuinely do not know whether
        // it succeeded, and guessing here would teach the model our guess
        // rather than the truth. Those rows are dropped below.
        label: res.status === 'succeeded' ? 1 : res.status === 'unknown' ? -1 : 0,
      });

      if (res.status === 'succeeded') break;
      railsSeen.add(rail);
      elapsed += delayH * HOUR;
      attemptNo++;
      if (res.error_reason) {
        lastReason = res.error_reason;
        lastSource = res.error_source ?? 'unknown';
        lastClass = classify(res);
      }
    }
  }

  return out.filter((s) => s.label >= 0);
}

async function main() {
  const n = Number(process.argv[2] ?? 12000);
  console.log(`exploring ${n} orders...`);
  const samples = explore(n);
  const pos = samples.filter((s) => s.label === 1).length;
  console.log(`  ${samples.length} labelled samples, ${pos} positive (${((pos / samples.length) * 100).toFixed(1)}%)`);

  await q(`DELETE FROM training_samples WHERE source='explorer'`);

  const cols = [
    'amount_paise', 'attempt_no', 'hours_since_first_failure', 'delay_hours',
    'decline_class', 'error_reason', 'error_source', 'original_rail',
    'candidate_rail', 'hour_of_day', 'day_of_month', 'prior_attempts',
    'rails_tried', 'label',
  ] as const;

  const CHUNK = 500;
  for (let i = 0; i < samples.length; i += CHUNK) {
    const batch = samples.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const rows = batch.map((s, r) => {
      const ph = cols.map((_, c) => `$${r * cols.length + c + 1}`);
      values.push(...cols.map((c) => (s as any)[c]));
      return `(${ph.join(',')})`;
    });
    await q(`INSERT INTO training_samples (${cols.join(',')}) VALUES ${rows.join(',')}`, values);
    process.stdout.write(`\r  inserted ${Math.min(i + CHUNK, samples.length)}/${samples.length}`);
  }
  console.log('\ndone. now run:  cd decision && python -m app.train');
  await pool.end();
}

// pathToFileURL, not string concatenation: on Windows a real file URL has
// three slashes and a drive letter, so the naive `file://${path}` form never
// matches and the script silently does nothing at all.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

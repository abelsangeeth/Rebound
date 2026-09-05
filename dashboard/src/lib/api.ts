import { useCallback, useEffect, useRef, useState } from 'react';

export async function get<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json() as Promise<T>;
}

export async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json() as Promise<T>;
}

/** Poll an endpoint. Skips a tick while one is still in flight, so a slow
 *  response can never stack up a queue of overlapping requests. */
export function usePoll<T>(path: string, ms: number, enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      setData(await get<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      busy.current = false;
    }
  }, [path]);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const t = setInterval(refresh, ms);
    return () => clearInterval(t);
  }, [refresh, ms, enabled]);

  return { data, error, refresh };
}

// --- formatting -------------------------------------------------------
// Money is paise everywhere in the system. It becomes rupees exactly once,
// here, at the edge where a human reads it.

export function rupees(paise: number | undefined | null): string {
  const n = Number(paise ?? 0) / 100;
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(2)} L`;
  return `${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export const pct = (x: number | undefined | null, dp = 1) =>
  `${((Number(x ?? 0)) * 100).toFixed(dp)}%`;

export const num = (x: number | undefined | null) => Number(x ?? 0).toLocaleString('en-IN');

export function delay(seconds: number | null | undefined): string {
  const s = Number(seconds ?? 0);
  if (!s) return '—';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// --- shared types -----------------------------------------------------

export interface Metrics {
  orders: number;
  at_risk: number;
  at_risk_value: number;
  recovered: number;
  recovered_value: number;
  ceiling_count: number;
  ceiling_value: number;
  wasted_retries: number;
  total_retries: number;
  total_attempts: number;
  abandoned: number;
  capture_of_ceiling: number;
  ledger: { payable: number; fees: number; groups: number };
  webhooks: { total: number; duplicates: number; rejected: number };
  worker: { processed: number; retries: number; reconciles: number; blocked: number; errors: number; queued: number };
  clock: { virtualNow: number; speed: number };
}

export interface Invariant {
  name: string;
  statement: string;
  ok: boolean;
  observed: string;
}

export interface Decision {
  id: string;
  order_id: string;
  after_attempt: number;
  should_retry: boolean;
  delay_seconds: number | null;
  rail: string | null;
  p_success: number | null;
  ev_paise: number | null;
  policy: string;
  reasons: string[];
  created_at: string;
  amount_paise: number;
  sim_cohort: string;
}

export interface Rail {
  rail: string;
  attempts: number;
  successes: number;
  issuer_errors: number;
  rate: number;
  wilson: number;
  breaker_open: boolean;
}

export interface Cohort {
  cohort: string;
  n: number;
  recovered: number;
  recoverable: boolean;
  avg_attempts: string;
}

export interface Order {
  id: string;
  merchant_id: string;
  customer_id: string;
  amount_paise: number;
  status: string;
  sim_cohort: string;
  sim_recoverable: boolean;
  original_rail: string;
  attempts: number;
  last_reason: string | null;
  decline_class: string | null;
  created_at: string;
}

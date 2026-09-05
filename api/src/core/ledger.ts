import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { isUniqueViolation } from './db.js';

// Append-only double-entry ledger.
//
// Accounts:
//   gateway_clearing  asset      -- money the PG owes us, pre-settlement
//   merchant_payable  liability  -- money we owe the merchant
//   fee_expense       expense    -- what the rail cost us
//
// Every posting writes one entry_group whose debits equal its credits. There
// is no UPDATE path and no DELETE path: a correction is a new reversing group.

export interface Leg {
  account: string;
  direction: 'debit' | 'credit';
  amount_paise: number;
}

export class UnbalancedEntry extends Error {}

/**
 * Write one balanced entry group.
 *
 * Exported so the chaos console can aim a deliberately unbalanced group at
 * the real posting path. A stand-in would prove nothing about this one.
 */
export async function postGroup(
  c: PoolClient,
  orderId: string,
  legs: Leg[],
  refType: string,
  refId: string,
  memo: string,
) {
  const net = legs.reduce(
    (a, l) => a + (l.direction === 'debit' ? l.amount_paise : -l.amount_paise),
    0,
  );
  // Refuse to write an unbalanced group rather than let the database hold a
  // lie that the invariant view would report later.
  if (net !== 0) throw new UnbalancedEntry(`entry does not balance: net ${net} paise`);

  const group = randomUUID();
  for (const l of legs) {
    if (l.amount_paise <= 0) continue;
    await c.query(
      `INSERT INTO ledger_entries
         (entry_group, order_id, account, direction, amount_paise, ref_type, ref_id, memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [group, orderId, l.account, l.direction, l.amount_paise, refType, refId, memo],
    );
  }
  return group;
}

/**
 * Post a successful capture. Returns null if this attempt was already
 * settled -- the partial unique index rejects the second write, which is how
 * a replayed webhook becomes a no-op instead of a double credit.
 */
export async function postCapture(
  c: PoolClient,
  orderId: string,
  attemptId: string,
  amountPaise: number,
  feePaise: number,
): Promise<string | null> {
  const legs: Leg[] = [
    { account: 'gateway_clearing', direction: 'debit', amount_paise: amountPaise - feePaise },
    { account: 'fee_expense', direction: 'debit', amount_paise: feePaise },
    { account: 'merchant_payable', direction: 'credit', amount_paise: amountPaise },
  ];
  try {
    return await postGroup(c, orderId, legs, 'attempt', attemptId, 'capture');
  } catch (e) {
    if (isUniqueViolation(e)) return null; // already settled; idempotent replay
    throw e;
  }
}

/** Reverse a capture. Used by the "instant refund as honest exit" path. */
export async function postRefund(
  c: PoolClient,
  orderId: string,
  refundId: string,
  amountPaise: number,
) {
  return postGroup(
    c,
    orderId,
    [
      { account: 'merchant_payable', direction: 'debit', amount_paise: amountPaise },
      { account: 'gateway_clearing', direction: 'credit', amount_paise: amountPaise },
    ],
    'refund',
    refundId,
    'refund',
  );
}

/** Rail cost model in basis points. Real numbers vary by contract; these are
 *  representative and only affect the expected-value maths, never correctness. */
export const RAIL_FEE_BPS: Record<string, number> = {
  upi: 0,
  upi_autopay: 0,
  card: 200,
  card_token: 200,
  netbanking: 180,
  wallet: 220,
  emi: 300,
  paylater: 280,
};

export const feeFor = (rail: string, amountPaise: number) =>
  Math.round((amountPaise * (RAIL_FEE_BPS[rail] ?? 200)) / 10000);

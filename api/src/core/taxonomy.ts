// Decline taxonomy.
//
// The single most important classification in the whole system:
//
//   hard      -- the money will never arrive on this instrument. Retrying is
//                pure cost, annoys the customer, and looks like card testing.
//   soft      -- the failure is about *timing* or *state*, not validity.
//                The same instrument can succeed later.
//   ambiguous -- we do not know whether the customer was charged. A retry here
//                risks a DOUBLE CHARGE. Must reconcile against the provider
//                before any further attempt. This is the one everybody gets
//                wrong, because a timeout looks like a failure and is not one.
//
// VERIFY THESE AGAINST CURRENT RAZORPAY DOCS BEFORE THE DEMO. Error reason
// strings drift between API versions and a stale mapping is the kind of thing
// a Razorpay judge will spot in ten seconds.
//   https://razorpay.com/docs/errors/

export type DeclineClass = 'hard' | 'soft' | 'ambiguous';

export interface FailureSignal {
  error_code?: string | null;
  error_reason?: string | null;
  error_source?: string | null;
  error_step?: string | null;
  error_description?: string | null;
}

const HARD = new Set([
  'card_expired',
  'incorrect_card_details',
  'invalid_card_number',
  'invalid_expiry',
  'card_blocked',
  'card_disabled',
  'card_not_supported',
  'international_transaction_not_allowed',
  'invalid_vpa',
  'account_closed',
  'account_blocked',
  'risk_threshold_breached',
  'payment_cancelled',
  'fraudulent_payment',
]);

const SOFT = new Set([
  'insufficient_funds',
  'payment_limit_exceeded',
  'max_amount_exceeded',
  'issuer_down',
  'gateway_error',
  'gateway_technical_error',
  'authentication_failed',
  'invalid_otp',
  'upi_collect_expired',
  'bank_transfer_failed',
  'server_error',
  'do_not_honour',
  'transaction_not_permitted',
]);

const AMBIGUOUS = new Set([
  'payment_timeout',
  'network_error',
  'payment_pending',
  'auto_capture_timeout',
  'response_timeout',
]);

export function classify(sig: FailureSignal): DeclineClass {
  const reason = (sig.error_reason ?? '').toLowerCase();
  const code = (sig.error_code ?? '').toLowerCase();

  if (AMBIGUOUS.has(reason)) return 'ambiguous';
  if (HARD.has(reason)) return 'hard';
  if (SOFT.has(reason)) return 'soft';

  // The step matters more than the reason string when the reason is unknown.
  // A failure at capture or in the response means the authorisation may
  // already have succeeded -- treat as unknown, never as failed.
  if (sig.error_step === 'payment_capture' || sig.error_step === 'payment_response') {
    return 'ambiguous';
  }
  if (sig.error_source === 'network') return 'ambiguous';

  // BAD_REQUEST_ERROR is the customer/instrument being wrong; that does not
  // fix itself with time.
  if (code === 'bad_request_error') return 'hard';
  if (code === 'gateway_error' || code === 'server_error') return 'soft';

  // Unknown reason on an unknown step: refuse to guess in the direction that
  // can double-charge. Default to the safe side.
  return 'ambiguous';
}

/** Reasons where retrying the SAME amount is pointless but a smaller/split
 *  ask, or an EMI conversion, plausibly converts. Drives the affordability
 *  pivot instead of a blind re-attempt. */
export const AFFORDABILITY_REASONS = new Set([
  'insufficient_funds',
  'payment_limit_exceeded',
  'max_amount_exceeded',
]);

/** Issuer-side failures. Used by the circuit breaker to tell "this bank is
 *  having an outage" (pause everyone, retry soon) apart from "this customer
 *  was declined" (do not pause anything). */
export const ISSUER_REASONS = new Set([
  'issuer_down',
  'gateway_error',
  'gateway_technical_error',
  'server_error',
  'do_not_honour',
]);

export const isAffordability = (s: FailureSignal) =>
  AFFORDABILITY_REASONS.has((s.error_reason ?? '').toLowerCase());
export const isIssuerSide = (s: FailureSignal) =>
  ISSUER_REASONS.has((s.error_reason ?? '').toLowerCase());

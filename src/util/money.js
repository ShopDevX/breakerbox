/** Money formatting helpers. All amounts are USD. */

/** Round to cents, avoiding float drift on sums. */
export function round(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/** Format as $X.XX, with extra precision for sub-cent hourly rates. */
export function usd(n) {
  if (!Number.isFinite(n)) return '$0.00';
  const abs = Math.abs(n);
  if (abs > 0 && abs < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** Format a rate like $0.4160/hr. */
export function rate(n) {
  if (!Number.isFinite(n) || n === 0) return '$0/hr';
  return `$${n.toFixed(4)}/hr`;
}

/** Clamp to a non-negative finite number. */
export function amount(n) {
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

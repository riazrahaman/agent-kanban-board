/**
 * SEC-07 (v2.6.0) — constant-time-ish comparison that does NOT early-return on
 * length mismatch. The previous per-module copies compared `a.length !== b.length`
 * and returned immediately, which leaks the secret's length to a timing
 * attacker. This version always iterates over the longer string, XOR-ing
 * missing bytes against zero, so the loop duration depends on the attacker's
 * input (the shorter/longer of the two) rather than on the secret alone.
 *
 * Token values here are short shared secrets, not password hashes, but avoiding
 * an early-exit compare costs nothing and closes the length-leak.
 */
export function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const max = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < max; i += 1) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}
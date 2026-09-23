/**
 * Mirror of the server-side escaping contract (spec Sec 6.3 A03, KB-07).
 *
 * The server escapes untrusted text on write (`server/utils/sanitize.js`), so
 * every stored title/description/log message arrives over the API with the five
 * entities below. React renders values as text nodes, which re-escapes anything
 * dangerous — but the raw entities themselves reach the user as visible noise
 * ("it&#039;s"). `decodeStored` restores the human-readable text for display
 * only; the store keeps the escaped form so the round-trip to the API and any
 * non-browser consumer stays byte-identical.
 */

/** Entities the server escapes, in decode order. */
const DECODE_ORDER: Array<[string, string]> = [
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#039;', "'"],
  ['&amp;', '&'],
]

/**
 * Decode the entity set the server escapes. Order matters: the specific
 * entities must go first and `&amp;` LAST, or a stored `&amp;lt;` would decode
 * twice into a real '<'. (Same invariant as `server/notifier.js` DECODE_ORDER.)
 */
export function decodeStored(str: string): string {
  if (typeof str !== 'string') return ''
  let out = str
  for (const [entity, char] of DECODE_ORDER) out = out.split(entity).join(char)
  return out
}

/**
 * Escapes untrusted text to prevent Stored XSS (spec Sec 6.3 A03, KB-07).
 * Kept as the definition of the entity set `decodeStored` inverts.
 */
export function escapeHtml(str: string): string {
  if (typeof str !== 'string') return ''
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
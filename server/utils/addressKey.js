/**
 * Groups addresses into owners: IPv4 by full address (IPv4-mapped IPv6 is
 * unwrapped to its IPv4 form), IPv6 by its /64 prefix, so one host cannot
 * multiply its allowance by rotating addresses inside its own prefix.
 */
export function addressOwnerKey(address) {
  if (typeof address !== 'string' || address === '') return null;
  let a = address.trim().toLowerCase();
  const zone = a.indexOf('%');
  if (zone !== -1) a = a.slice(0, zone);
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a) || /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return mapped[1];
  if (!a.includes(':')) return a; // IPv4 (or an opaque token)
  // Expand '::' and keep the first four hextets (the /64).
  let head = a;
  let tail = '';
  const dbl = a.indexOf('::');
  if (dbl !== -1) { head = a.slice(0, dbl); tail = a.slice(dbl + 2); }
  const h = head === '' ? [] : head.split(':');
  const t = tail === '' ? [] : tail.split(':');
  const fill = dbl !== -1 ? Math.max(0, 8 - h.length - t.length) : 0;
  const groups = [...h, ...Array(fill).fill('0'), ...t].slice(0, 4);
  while (groups.length < 4) groups.push('0');
  return `v6:${groups.map((g) => (g.replace(/^0+(?=.)/, '') || '0')).join(':')}`;
}

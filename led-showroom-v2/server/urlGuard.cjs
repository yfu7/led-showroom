/*
 * urlGuard — the one address guard shared by both website proxies.
 *
 * Consumers:
 *   api/proxy.js      (ESM, Vercel serverless)  -> import guard from '../server/urlGuard.cjs'
 *   server/index.cjs  (CommonJS, local server)  -> require('./urlGuard.cjs')
 *
 * The file is CommonJS (.cjs) on purpose. package.json is "type": "module", so a bare .js here
 * would be ESM and require() from server/index.cjs would throw ERR_REQUIRE_ESM. The reverse
 * direction has no such problem: Node's ESM loader imports a CommonJS module happily, so the
 * serverless function loads this exact file. One implementation, both runtimes — see
 * src/server/urlGuard.test.ts, which loads it the CommonJS way, and the ESM smoke check in the
 * same file's header comment.
 *
 * What it stops, before a single packet leaves the process:
 *   - anything that is not http: or https:
 *   - URLs carrying embedded credentials (https://user:pass@host/)
 *   - hosts that resolve to a non-public-unicast address (SSRF, and cloud instance metadata at
 *     169.254.169.254 in particular). DNS is resolved here and EVERY returned address is checked.
 *   - DNS rebinding: the caller connects to the exact address that was validated (pinnedLookup).
 */
'use strict';

const dns = require('node:dns');

/* ── limits ── */
const MAX_REDIRECTS = 5;                     // redirect hops, counted across proxy bounces
const MAX_HTML_BYTES = 5 * 1024 * 1024;      // buffered-HTML cap (the streamed path is not buffered)
const REQUEST_TIMEOUT_MS = 10000;            // unchanged from the original proxies

/* One message for every address-level rejection: a blocked private host, a host that does not
 * resolve and a host that resolves to nothing are indistinguishable from the outside, so the
 * proxy cannot be used to probe what exists inside the hosting network. */
const BLOCKED_MESSAGE = 'That address is not allowed.';
const TOO_MANY_REDIRECTS_MESSAGE = 'Too many redirects.';
const BODY_TOO_LARGE_MESSAGE = 'The upstream page is too large to display.';

/* ── IPv4 ── */

/**
 * Parse a dotted quad into a 32-bit number. Strict: four decimal octets, no octal-looking
 * leading zeros, no shorthand forms. (The WHATWG URL parser already normalises 0177.0.0.1 and
 * 2130706433 to a dotted quad before we ever see the host, so strictness here costs nothing.)
 */
function parseIPv4(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (part.length < 1 || part.length > 3) return null;
    if (part.length > 1 && part[0] === '0') return null;
    for (let i = 0; i < part.length; i++) {
      const c = part.charCodeAt(i);
      if (c < 48 || c > 57) return null;
    }
    const octet = Number(part);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n >>> 0;
}

/** [first address of the block, prefix length, why it is blocked] */
const IPV4_BLOCKS = [
  ['0.0.0.0', 8, 'this-network / unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local (cloud instance metadata)'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4 relay anycast'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
].map(([base, bits, reason]) => ({
  base: parseIPv4(base),
  mask: bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0,
  bits,
  reason,
}));

const IPV4_BROADCAST = parseIPv4('255.255.255.255');

/** Why this IPv4 address (as a 32-bit number) is not public unicast, or null when it is fine. */
function ipv4Reason(n) {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 0xffffffff) return 'unparseable address';
  if (n === IPV4_BROADCAST) return 'broadcast';
  for (const block of IPV4_BLOCKS) {
    if (((n & block.mask) >>> 0) === block.base) return block.reason;
  }
  return null;
}

/* ── IPv6 ── */

/** Parse an IPv6 literal (including a trailing embedded IPv4) into 16 bytes, or null. */
function parseIPv6(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.indexOf('%') !== -1) return null;              // scoped literal: never routable, treat as unusable
  let text = value;

  const lastColon = text.lastIndexOf(':');
  if (lastColon === -1) return null;
  const tail = text.slice(lastColon + 1);
  if (tail.indexOf('.') !== -1) {                          // ::ffff:169.254.169.254 and friends
    const v4 = parseIPv4(tail);
    if (v4 === null) return null;
    text = text.slice(0, lastColon + 1) + ((v4 >>> 16) & 0xffff).toString(16) + ':' + (v4 & 0xffff).toString(16);
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const rest = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : null;
  if (rest === null ? head.length !== 8 : head.length + rest.length > 7) return null;

  const bytes = new Uint8Array(16);
  const write = (group, index) => {
    if (group.length < 1 || group.length > 4) return false;
    for (let i = 0; i < group.length; i++) {
      const c = group.charCodeAt(i);
      const hex = (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
      if (!hex) return false;
    }
    const v = parseInt(group, 16);
    bytes[index * 2] = (v >>> 8) & 0xff;
    bytes[index * 2 + 1] = v & 0xff;
    return true;
  };
  for (let i = 0; i < head.length; i++) if (!write(head[i], i)) return null;
  if (rest !== null) {
    for (let i = 0; i < rest.length; i++) if (!write(rest[i], 8 - rest.length + i)) return null;
  }
  return bytes;
}

function matchesPrefix(bytes, prefix, bits) {
  const whole = bits >> 3;
  for (let i = 0; i < whole; i++) if (bytes[i] !== prefix[i]) return false;
  const remainder = bits & 7;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (bytes[whole] & mask) === (prefix[whole] & mask);
}

const IPV6_BLOCKS = [
  ['100::', 64, 'discard-only'],
  ['2001:db8::', 32, 'documentation'],
  ['2001::', 32, 'Teredo'],
  ['fc00::', 7, 'unique-local'],
  ['fe80::', 10, 'link-local'],
  ['ff00::', 8, 'multicast'],
].map(([base, bits, reason]) => ({ prefix: parseIPv6(base), bits, reason }));

/* Prefixes that carry an IPv4 address inside them. The embedded address is unwrapped and
 * re-checked against the IPv4 rules, so ::ffff:169.254.169.254 is blocked for the same reason
 * 169.254.169.254 is. `at` is the byte offset of the embedded address. */
const IPV6_EMBEDDED_IPV4 = [
  { base: '::ffff:0:0', bits: 96, at: 12, label: 'IPv4-mapped' },
  { base: '::ffff:0:0:0', bits: 96, at: 12, label: 'IPv4-translated' },
  { base: '64:ff9b::', bits: 96, at: 12, label: 'NAT64' },
  { base: '64:ff9b:1::', bits: 48, at: 12, label: 'NAT64' },
  { base: '2002::', bits: 16, at: 2, label: '6to4' },
  { base: '::', bits: 96, at: 12, label: 'IPv4-compatible' },   // deprecated; keep last, after ::/128 and ::1
].map(entry => ({ ...entry, prefix: parseIPv6(entry.base) }));

const readIPv4At = (bytes, at) => (((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0);

/** Why this IPv6 address (16 bytes) is not public unicast, or null when it is fine. */
function ipv6Reason(bytes) {
  if (!bytes || bytes.length !== 16) return 'unparseable address';
  let allZero = true;
  for (let i = 0; i < 16; i++) if (bytes[i] !== 0) { allZero = false; break; }
  if (allZero) return 'IPv6 unspecified (::)';
  let loopback = bytes[15] === 1;
  if (loopback) for (let i = 0; i < 15; i++) if (bytes[i] !== 0) { loopback = false; break; }
  if (loopback) return 'IPv6 loopback';

  for (const entry of IPV6_EMBEDDED_IPV4) {
    if (!matchesPrefix(bytes, entry.prefix, entry.bits)) continue;
    const reason = ipv4Reason(readIPv4At(bytes, entry.at));
    return reason === null ? null : entry.label + ' ' + reason;
  }
  for (const block of IPV6_BLOCKS) {
    if (matchesPrefix(bytes, block.prefix, block.bits)) return block.reason;
  }
  return null;
}

/**
 * Classify one literal address.
 * @returns {{ family: 0|4|6, blocked: boolean, reason: string|null }}
 *          family 0 means "not an address we can parse" — always blocked.
 */
function classifyAddress(address) {
  const v4 = parseIPv4(address);
  if (v4 !== null) {
    const reason = ipv4Reason(v4);
    return { family: 4, blocked: reason !== null, reason };
  }
  const v6 = parseIPv6(address);
  if (v6 !== null) {
    const reason = ipv6Reason(v6);
    return { family: 6, blocked: reason !== null, reason };
  }
  return { family: 0, blocked: true, reason: 'unparseable address' };
}

/** True when the literal address is a public unicast address the proxy may connect to. */
function isPublicUnicastAddress(address) {
  return !classifyAddress(address).blocked;
}

/* ── URL checks ── */

const firstValue = (value) => (Array.isArray(value) ? value[0] : value);

/**
 * Synchronous, network-free checks on the ?url= parameter.
 * @returns {{ ok: true, url: URL } | { ok: false, status: number, message: string }}
 */
function checkTargetUrl(rawUrl) {
  const raw = firstValue(rawUrl);
  if (!raw || typeof raw !== 'string') return { ok: false, status: 400, message: 'Missing ?url= parameter' };
  let url;
  try { url = new URL(raw); } catch { return { ok: false, status: 400, message: 'Invalid URL' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, status: 400, message: 'Unsupported protocol' };
  if (url.username !== '' || url.password !== '') return { ok: false, status: 400, message: 'URLs with embedded credentials are not allowed.' };
  if (url.hostname === '') return { ok: false, status: 400, message: 'Invalid URL' };
  return { ok: true, url };
}

/** url.hostname keeps the brackets on an IPv6 literal; the resolver and classifier want it bare. */
function bareHostname(url) {
  const host = url.hostname;
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * Full check: protocol, credentials, then DNS — every returned address must be public unicast.
 * @param {string} rawUrl
 * @param {{ lookup?: (hostname: string) => Promise<Array<{ address: string, family: number }>> }} [options]
 * @returns {Promise<{ ok: true, url: URL, address: string, family: 4|6 }
 *                 | { ok: false, status: number, message: string, reason?: string }>}
 */
async function resolveSafeTarget(rawUrl, options) {
  const checked = checkTargetUrl(rawUrl);
  if (!checked.ok) return checked;
  const url = checked.url;
  const hostname = bareHostname(url);

  const literal = classifyAddress(hostname);
  if (literal.family !== 0) {
    if (literal.blocked) return { ok: false, status: 403, message: BLOCKED_MESSAGE, reason: literal.reason };
    return { ok: true, url, address: hostname, family: literal.family };
  }

  const lookup = (options && options.lookup) || ((name) => dns.promises.lookup(name, { all: true, verbatim: true }));
  let records;
  try {
    records = await lookup(hostname);
  } catch {
    // A host that does not resolve gets the same answer as a blocked one, on purpose.
    return { ok: false, status: 403, message: BLOCKED_MESSAGE, reason: 'dns lookup failed' };
  }
  if (!Array.isArray(records) || records.length === 0) {
    return { ok: false, status: 403, message: BLOCKED_MESSAGE, reason: 'no addresses' };
  }
  for (const record of records) {
    const verdict = classifyAddress(record && record.address);
    if (verdict.blocked) return { ok: false, status: 403, message: BLOCKED_MESSAGE, reason: verdict.reason };
  }
  const first = records[0];
  return { ok: true, url, address: first.address, family: classifyAddress(first.address).family };
}

/**
 * Close the check-to-connect gap. Passed as the http/https `lookup` option, it hands the socket
 * the exact address resolveSafeTarget() validated, so a name that answers with a public address
 * for the check and a private one a moment later (DNS rebinding) still connects to the checked
 * address. The request keeps the original hostname, so the Host header and the TLS SNI /
 * certificate check are unchanged — the same outcome as setting host=<ip> plus Host and
 * servername overrides by hand, without the risk of the three drifting apart.
 */
function pinnedLookup(address, family) {
  return function lookup(hostname, opts, callback) {
    const cb = typeof opts === 'function' ? opts : callback;
    const wantsAll = typeof opts === 'object' && opts !== null && opts.all === true;
    process.nextTick(() => {
      if (wantsAll) cb(null, [{ address, family }]);
      else cb(null, address, family);
    });
  };
}

/* ── request / response plumbing shared by both proxies ── */

const UPSTREAM_REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  // Identity keeps the byte cap honest (a compressed body cannot expand past it) and keeps the
  // buffered HTML path from base-tagging gzip bytes.
  'Accept-Encoding': 'identity',
};

/**
 * Build the http/https request options: the original URL (so Host and SNI stay correct), the
 * pinned address, and no agent pooling — a pooled socket could otherwise be reused for a host
 * whose address was never validated on this request.
 */
function upstreamRequestOptions(url, address, family) {
  const options = {
    method: 'GET',
    headers: { ...UPSTREAM_REQUEST_HEADERS },
    lookup: pinnedLookup(address, family),
    agent: false,
  };
  if (url.protocol === 'https:') options.servername = bareHostname(url);
  return options;
}

/* Never forwarded downstream:
 *   x-frame-options / content-security-policy*  — the whole point of the proxy
 *   set-cookie / set-cookie2                    — upstream cookies would land on OUR origin
 *   access-control-*                            — upstream CORS would let third-party JS read
 *                                                 whatever the proxy fetched */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'set-cookie',
  'set-cookie2',
]);

function isStrippedResponseHeader(name) {
  const lower = String(name).toLowerCase();
  return STRIPPED_RESPONSE_HEADERS.has(lower) || lower.startsWith('access-control-');
}

/**
 * Copy the upstream headers, dropping the ones above. No CORS header is added: the proxy is only
 * ever used as an iframe src (proxyUrl() in src/engine/content/ContentLayer.ts, consumed by
 * ContentLayer and LedWallRenderer), and an iframe navigation is not a CORS request.
 *
 * Keys come back lower-cased so a caller that overrides one (content-type on the rewritten HTML)
 * replaces it instead of emitting the header twice.
 */
function filterResponseHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (isStrippedResponseHeader(key)) continue;
    out[String(key).toLowerCase()] = value;
  }
  return out;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const isRedirectStatus = (status) => REDIRECT_STATUSES.has(status);

/** Read the hop counter this proxy adds to its own redirect URLs. Anything odd counts as 0. */
function readHopCount(value) {
  const n = Number.parseInt(firstValue(value), 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_REDIRECTS + 1);
}

/**
 * Location for the next hop, or null when the cap is reached. Each hop re-enters the proxy, so
 * the guard runs again on every one of them — the counter only stops a redirect loop pinning the
 * process.
 */
function redirectLocation(basePath, nextUrl, hops) {
  const next = hops + 1;
  if (next > MAX_REDIRECTS) return null;
  return basePath + '?url=' + encodeURIComponent(nextUrl) + '&hops=' + next;
}

module.exports = {
  MAX_REDIRECTS,
  MAX_HTML_BYTES,
  REQUEST_TIMEOUT_MS,
  BLOCKED_MESSAGE,
  TOO_MANY_REDIRECTS_MESSAGE,
  BODY_TOO_LARGE_MESSAGE,
  parseIPv4,
  parseIPv6,
  ipv4Reason,
  ipv6Reason,
  classifyAddress,
  isPublicUnicastAddress,
  checkTargetUrl,
  resolveSafeTarget,
  bareHostname,
  pinnedLookup,
  upstreamRequestOptions,
  filterResponseHeaders,
  isStrippedResponseHeader,
  isRedirectStatus,
  readHopCount,
  redirectLocation,
};

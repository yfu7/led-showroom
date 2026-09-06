/**
 * Tests for the shared proxy address guard (server/urlGuard.cjs), used by both api/proxy.js
 * (ESM, Vercel) and server/index.cjs (CommonJS, local server).
 *
 * Why the test lives under src/: vitest.config.ts collects `src/**‍/*.test.ts` only, so this is
 * where the runner can see it. It loads the guard through createRequire — the real CommonJS
 * entry point, exactly as server/index.cjs does — which also keeps the .cjs file out of the
 * TypeScript module graph (tsconfig has no allowJs).
 *
 * No test here touches the network: DNS is injected.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

interface Verdict { family: 0 | 4 | 6; blocked: boolean; reason: string | null }
type DnsRecord = { address: string; family: number };
type CheckResult = { ok: true; url: URL } | { ok: false; status: number; message: string };
type ResolveResult =
  | { ok: true; url: URL; address: string; family: number }
  | { ok: false; status: number; message: string; reason?: string };

interface UrlGuard {
  MAX_REDIRECTS: number;
  MAX_HTML_BYTES: number;
  REQUEST_TIMEOUT_MS: number;
  BLOCKED_MESSAGE: string;
  TOO_MANY_REDIRECTS_MESSAGE: string;
  parseIPv4(value: unknown): number | null;
  parseIPv6(value: unknown): Uint8Array | null;
  classifyAddress(address: unknown): Verdict;
  isPublicUnicastAddress(address: string): boolean;
  checkTargetUrl(raw: unknown): CheckResult;
  resolveSafeTarget(raw: unknown, options?: { lookup?: (host: string) => Promise<DnsRecord[]> }): Promise<ResolveResult>;
  pinnedLookup(address: string, family: number): (host: string, opts: unknown, cb?: unknown) => void;
  upstreamRequestOptions(url: URL, address: string, family: number): Record<string, unknown>;
  filterResponseHeaders(headers: Record<string, unknown>): Record<string, unknown>;
  isRedirectStatus(status: number): boolean;
  readHopCount(value: unknown): number;
  redirectLocation(basePath: string, next: string, hops: number): string | null;
}

const guard = createRequire(import.meta.url)('../../server/urlGuard.cjs') as UrlGuard;

const blocked = (address: string) => guard.classifyAddress(address).blocked;
const reasonFor = (address: string) => guard.classifyAddress(address).reason;

describe('classifyAddress — IPv4 blocked ranges', () => {
  const cases: Array<[string, string]> = [
    ['0.0.0.0', 'this-network / unspecified'],
    ['0.255.255.255', 'this-network / unspecified'],
    ['10.0.0.0', 'private'],
    ['10.255.255.255', 'private'],
    ['100.64.0.0', 'carrier-grade NAT'],
    ['100.127.255.255', 'carrier-grade NAT'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.169.254', 'link-local (cloud instance metadata)'],   // the cloud metadata address
    ['169.254.0.0', 'link-local (cloud instance metadata)'],
    ['172.16.0.0', 'private'],
    ['172.31.255.255', 'private'],
    ['192.0.0.1', 'IETF protocol assignments'],
    ['192.0.2.5', 'documentation'],
    ['192.88.99.1', '6to4 relay anycast'],
    ['192.168.0.1', 'private'],
    ['192.168.255.255', 'private'],
    ['198.18.0.1', 'benchmarking'],
    ['198.51.100.9', 'documentation'],
    ['203.0.113.9', 'documentation'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
  ];
  it.each(cases)('blocks %s (%s)', (address, reason) => {
    expect(blocked(address)).toBe(true);
    expect(reasonFor(address)).toBe(reason);
  });
});

describe('classifyAddress — public IPv4 is allowed', () => {
  // Without these the whole suite would still pass if the guard blocked everything.
  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '151.101.1.140', '9.255.255.255', '11.0.0.0'];
  it.each(allowed)('allows %s', (address) => {
    expect(guard.classifyAddress(address)).toEqual({ family: 4, blocked: false, reason: null });
    expect(guard.isPublicUnicastAddress(address)).toBe(true);
  });

  it('is exact at the edges of the private blocks', () => {
    expect(blocked('172.15.255.255')).toBe(false);   // just below 172.16/12
    expect(blocked('172.16.0.0')).toBe(true);
    expect(blocked('172.31.255.255')).toBe(true);
    expect(blocked('172.32.0.0')).toBe(false);       // just above 172.16/12
    expect(blocked('100.63.255.255')).toBe(false);   // just below 100.64/10
    expect(blocked('100.128.0.0')).toBe(false);      // just above 100.64/10
    expect(blocked('169.253.255.255')).toBe(false);
    expect(blocked('169.255.0.0')).toBe(false);
    expect(blocked('126.255.255.255')).toBe(false);
    expect(blocked('128.0.0.0')).toBe(false);
    expect(blocked('223.255.255.255')).toBe(false);  // just below multicast
  });
});

describe('classifyAddress — IPv6', () => {
  const cases: Array<[string, string]> = [
    ['::', 'IPv6 unspecified (::)'],
    ['::1', 'IPv6 loopback'],
    ['fc00::1', 'unique-local'],
    ['fd12:3456:789a::1', 'unique-local'],
    ['fdff:ffff::1', 'unique-local'],
    ['fe80::1', 'link-local'],
    ['febf:ffff::1', 'link-local'],
    ['ff00::1', 'multicast'],
    ['ff02::1', 'multicast'],
    ['100::1', 'discard-only'],
    ['2001:db8::1', 'documentation'],
    ['2001::1', 'Teredo'],
  ];
  it.each(cases)('blocks %s (%s)', (address, reason) => {
    expect(blocked(address)).toBe(true);
    expect(reasonFor(address)).toBe(reason);
  });

  it('allows public IPv6', () => {
    for (const address of ['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:80e::200e']) {
      expect(guard.classifyAddress(address)).toEqual({ family: 6, blocked: false, reason: null });
    }
  });

  it('unwraps IPv4-mapped IPv6 and re-checks it against the IPv4 rules', () => {
    expect(reasonFor('::ffff:169.254.169.254')).toBe('IPv4-mapped link-local (cloud instance metadata)');
    expect(reasonFor('::ffff:127.0.0.1')).toBe('IPv4-mapped loopback');
    expect(reasonFor('::ffff:10.0.0.1')).toBe('IPv4-mapped private');
    expect(reasonFor('::ffff:192.168.1.1')).toBe('IPv4-mapped private');
    // the compressed hex spelling of the same address
    expect(reasonFor('::ffff:a9fe:a9fe')).toBe('IPv4-mapped link-local (cloud instance metadata)');
    // a mapped *public* address is still fine
    expect(blocked('::ffff:8.8.8.8')).toBe(false);
  });

  it('unwraps IPv4-compatible, NAT64 and 6to4 forms too', () => {
    expect(reasonFor('::127.0.0.1')).toBe('IPv4-compatible loopback');
    expect(reasonFor('::169.254.169.254')).toBe('IPv4-compatible link-local (cloud instance metadata)');
    expect(reasonFor('64:ff9b::169.254.169.254')).toBe('NAT64 link-local (cloud instance metadata)');
    expect(reasonFor('64:ff9b:1::7f00:1')).toBe('NAT64 loopback');
    expect(reasonFor('2002:a9fe:a9fe::1')).toBe('6to4 link-local (cloud instance metadata)');
    expect(reasonFor('2002:c0a8:101::1')).toBe('6to4 private');
  });

  it('rejects anything it cannot parse, including scoped literals', () => {
    for (const address of ['fe80::1%eth0', 'not-an-ip', '', '1:2:3:4:5:6:7', '1::2::3', '12345::1', 'gggg::1', '::ffff:999.1.1.1', '127.0.0.256', '127.0.1']) {
      expect(guard.classifyAddress(address)).toEqual({ family: 0, blocked: true, reason: 'unparseable address' });
    }
  });
});

describe('parseIPv4 / parseIPv6', () => {
  it('parses a dotted quad into a 32-bit number', () => {
    expect(guard.parseIPv4('0.0.0.0')).toBe(0);
    expect(guard.parseIPv4('127.0.0.1')).toBe(0x7f000001);
    expect(guard.parseIPv4('255.255.255.255')).toBe(0xffffffff);
  });

  it('refuses octal-looking and out-of-range octets', () => {
    expect(guard.parseIPv4('0177.0.0.1')).toBeNull();
    expect(guard.parseIPv4('127.0.0.01')).toBeNull();
    expect(guard.parseIPv4('256.0.0.1')).toBeNull();
    expect(guard.parseIPv4('2130706433')).toBeNull();
    expect(guard.parseIPv4(' 127.0.0.1')).toBeNull();
  });

  it('parses IPv6 into 16 bytes', () => {
    expect(Array.from(guard.parseIPv6('::') ?? [])).toEqual(new Array(16).fill(0));
    expect(Array.from(guard.parseIPv6('::1') ?? [])).toEqual([...new Array(15).fill(0), 1]);
    expect(Array.from(guard.parseIPv6('::ffff:127.0.0.1') ?? []).slice(10)).toEqual([0xff, 0xff, 127, 0, 0, 1]);
    expect(guard.parseIPv6('2606:4700:4700::1111')?.length).toBe(16);
  });
});

describe('checkTargetUrl', () => {
  it('accepts an ordinary http and https URL', () => {
    for (const raw of ['https://example.com/page', 'http://example.com:8080/a?b=c']) {
      const result = guard.checkTargetUrl(raw);
      expect(result.ok).toBe(true);
    }
  });

  it('rejects a missing parameter', () => {
    expect(guard.checkTargetUrl(undefined)).toMatchObject({ ok: false, status: 400, message: 'Missing ?url= parameter' });
    expect(guard.checkTargetUrl('')).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects non-http(s) schemes', () => {
    for (const raw of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com/', 'data:text/html,<b>hi', 'javascript:alert(1)']) {
      expect(guard.checkTargetUrl(raw)).toMatchObject({ ok: false, status: 400, message: 'Unsupported protocol' });
    }
  });

  it('rejects embedded credentials', () => {
    for (const raw of ['https://user:pass@example.com/', 'https://user@example.com/', 'http://:pass@example.com/']) {
      expect(guard.checkTargetUrl(raw)).toMatchObject({ ok: false, status: 400, message: 'URLs with embedded credentials are not allowed.' });
    }
  });

  it('rejects a URL that will not parse', () => {
    expect(guard.checkTargetUrl('http://')).toMatchObject({ ok: false, status: 400, message: 'Invalid URL' });
    expect(guard.checkTargetUrl('not a url')).toMatchObject({ ok: false, status: 400, message: 'Invalid URL' });
  });
});

describe('resolveSafeTarget', () => {
  const never = async (): Promise<DnsRecord[]> => { throw new Error('DNS must not be consulted'); };
  const answering = (...records: DnsRecord[]) => async () => records;

  it('blocks a literal private or metadata host without any DNS at all', async () => {
    for (const raw of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://[::ffff:169.254.169.254]/', 'http://192.168.1.1:8080/']) {
      const result = await guard.resolveSafeTarget(raw, { lookup: never });
      expect(result).toMatchObject({ ok: false, status: 403, message: guard.BLOCKED_MESSAGE });
    }
  });

  it('blocks the octal / decimal spellings of 127.0.0.1 (the URL parser normalises them first)', async () => {
    for (const raw of ['http://0177.0.0.1/', 'http://2130706433/', 'http://0x7f.1/']) {
      const result = await guard.resolveSafeTarget(raw, { lookup: never });
      expect(result).toMatchObject({ ok: false, status: 403, message: guard.BLOCKED_MESSAGE });
    }
  });

  it('allows a public literal and pins the address it validated', async () => {
    const result = await guard.resolveSafeTarget('https://93.184.216.34/x', { lookup: never });
    expect(result).toEqual({ ok: true, url: expect.any(URL), address: '93.184.216.34', family: 4 });
  });

  it('allows a name whose addresses are all public, and pins the first', async () => {
    const result = await guard.resolveSafeTarget('https://example.com/page', {
      lookup: answering({ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }),
    });
    expect(result).toMatchObject({ ok: true, address: '93.184.216.34', family: 4 });
  });

  it('blocks when ANY returned address is private, not just the first', async () => {
    const result = await guard.resolveSafeTarget('https://rebind.example/', {
      lookup: answering({ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }),
    });
    expect(result).toMatchObject({ ok: false, status: 403, message: guard.BLOCKED_MESSAGE });
  });

  it('gives the same non-500 answer whether the host is private, unresolvable or empty', async () => {
    const results = await Promise.all([
      guard.resolveSafeTarget('http://10.0.0.5/', { lookup: never }),
      guard.resolveSafeTarget('http://internal.corp/', { lookup: async () => { throw new Error('ENOTFOUND'); } }),
      guard.resolveSafeTarget('http://nothing.example/', { lookup: answering() }),
    ]);
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ status: 403, message: guard.BLOCKED_MESSAGE });
      // the message must not say which of the three happened
      expect((result as { message: string }).message).not.toMatch(/dns|resolve|private|loopback|10\.0\.0\.5/i);
    }
  });

  it('still refuses credentials and bad schemes before resolving', async () => {
    expect(await guard.resolveSafeTarget('https://user:pass@example.com/', { lookup: never }))
      .toMatchObject({ ok: false, status: 400 });
    expect(await guard.resolveSafeTarget('file:///etc/passwd', { lookup: never }))
      .toMatchObject({ ok: false, status: 400, message: 'Unsupported protocol' });
  });
});

describe('pinnedLookup', () => {
  it('answers with the validated address in both callback shapes', async () => {
    const lookup = guard.pinnedLookup('93.184.216.34', 4);
    const one = await new Promise<unknown[]>((resolve) => {
      lookup('rebind.example', {}, (...args: unknown[]) => resolve(args));
    });
    expect(one).toEqual([null, '93.184.216.34', 4]);

    const all = await new Promise<unknown[]>((resolve) => {
      lookup('rebind.example', { all: true }, (...args: unknown[]) => resolve(args));
    });
    expect(all).toEqual([null, [{ address: '93.184.216.34', family: 4 }]]);
  });
});

describe('upstreamRequestOptions', () => {
  it('pins the address, keeps SNI on the hostname and disables socket pooling', () => {
    const options = guard.upstreamRequestOptions(new URL('https://example.com/a'), '93.184.216.34', 4);
    expect(options.servername).toBe('example.com');
    expect(options.agent).toBe(false);
    expect(typeof options.lookup).toBe('function');
    expect(options.method).toBe('GET');
  });

  it('sets no servername for plain http', () => {
    const options = guard.upstreamRequestOptions(new URL('http://example.com/a'), '93.184.216.34', 4);
    expect(options.servername).toBeUndefined();
  });
});

describe('filterResponseHeaders', () => {
  it('drops frame, CSP, cookie and CORS headers and keeps the rest, lower-cased', () => {
    const out = guard.filterResponseHeaders({
      'Content-Type': 'text/html',
      'x-frame-options': 'DENY',
      'X-Frame-Options': 'SAMEORIGIN',
      'content-security-policy': "frame-ancestors 'none'",
      'content-security-policy-report-only': "default-src 'none'",
      'set-cookie': ['session=abc; HttpOnly'],
      'Set-Cookie': 'other=1',
      'set-cookie2': 'legacy=1',
      'access-control-allow-origin': '*',
      'access-control-allow-credentials': 'true',
      'Cache-Control': 'no-store',
    });
    // lower-cased, so an override of content-type replaces it instead of duplicating the header
    expect(out).toEqual({ 'content-type': 'text/html', 'cache-control': 'no-store' });
  });

  it('adds no CORS header of its own — the proxy is only ever an iframe src', () => {
    const out = guard.filterResponseHeaders({ 'content-type': 'text/html' });
    expect(Object.keys(out).some(k => k.toLowerCase().startsWith('access-control-'))).toBe(false);
  });
});

describe('redirect bounds', () => {
  it('counts hops and refuses past the cap', () => {
    expect(guard.readHopCount(undefined)).toBe(0);
    expect(guard.readHopCount('nonsense')).toBe(0);
    expect(guard.readHopCount('-3')).toBe(0);
    expect(guard.readHopCount('2')).toBe(2);
    expect(guard.readHopCount('9999')).toBe(guard.MAX_REDIRECTS + 1);

    expect(guard.redirectLocation('/proxy', 'https://example.com/next', 0))
      .toBe('/proxy?url=' + encodeURIComponent('https://example.com/next') + '&hops=1');
    expect(guard.redirectLocation('/proxy', 'https://example.com/next', guard.MAX_REDIRECTS - 1)).not.toBeNull();
    expect(guard.redirectLocation('/proxy', 'https://example.com/next', guard.MAX_REDIRECTS)).toBeNull();
    expect(guard.redirectLocation('/proxy', 'https://example.com/next', guard.MAX_REDIRECTS + 1)).toBeNull();
  });

  it('knows which statuses redirect', () => {
    for (const status of [301, 302, 303, 307, 308]) expect(guard.isRedirectStatus(status)).toBe(true);
    for (const status of [200, 204, 304, 404, 500]) expect(guard.isRedirectStatus(status)).toBe(false);
  });
});

describe('limits', () => {
  it('keeps the 10 s timeout and caps the buffered body', () => {
    expect(guard.REQUEST_TIMEOUT_MS).toBe(10000);
    expect(guard.MAX_HTML_BYTES).toBeGreaterThan(0);
    expect(guard.MAX_HTML_BYTES).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(guard.MAX_REDIRECTS).toBeGreaterThan(0);
  });
});

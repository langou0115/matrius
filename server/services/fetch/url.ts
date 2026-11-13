import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

import ipaddr from 'ipaddr.js';

import { invalid } from '../../errors';

const BLOCKED_HOSTS = new Set([
  'localhost',
  'host.docker.internal',
  'metadata.google.internal',
]);
const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa'];

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/gu, '');
}

function isPublicAddress(address: string): boolean {
  let parsed: ReturnType<typeof ipaddr.parse>;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return false;
  }
  if (parsed.kind() === 'ipv6') {
    const ipv6 = parsed as unknown as {
      isIPv4MappedAddress(): boolean;
      toIPv4Address(): { toString(): string };
    };
    if (ipv6.isIPv4MappedAddress()) return isPublicAddress(ipv6.toIPv4Address().toString());
  }
  // `unicast` is the only public range in ipaddr.js; private, loopback,
  // link-local, ULA, multicast, reserved and CGNAT are rejected.
  return parsed.range() === 'unicast';
}

function validateHostname(hostname: string): void {
  const host = normalizedHostname(hostname);
  if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw invalid('出于安全原因，不能读取本机或内网地址。');
  }
  if (isIP(host) && !isPublicAddress(host)) {
    throw invalid('出于安全原因，不能读取本机或内网地址。');
  }
}

async function resolveAddresses(hostname: string, port: number): Promise<string[]> {
  try {
    const rows = await dns.lookup(hostname, { all: true, verbatim: true });
    void port;
    return rows.map((row) => row.address);
  } catch {
    throw invalid('无法解析该网页地址。');
  }
}

/**
 * Validate one URL and every DNS answer before a request is made.
 *
 * This is intentionally independent of the HTTP client: redirects and batches
 * re-run it for every hop. The Python server validated all answers as global;
 * ipaddr.js `range() === 'unicast'` is the closest equivalent.
 */
export async function validateFetchUrl(raw: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw invalid('网页地址不合法。');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalid('网页地址必须是有效的 http 或 https 地址。');
  }
  if (url.username || url.password) {
    throw invalid('网页地址不能包含用户名或密码。');
  }
  if (!url.hostname) throw invalid('网页地址不合法。');

  validateHostname(url.hostname);
  let port: number;
  try {
    port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  } catch {
    throw invalid('网页地址不合法。');
  }

  const literal = normalizedHostname(url.hostname);
  const addresses = isIP(literal) ? [literal] : await resolveAddresses(literal, port);
  if (!addresses.length) throw invalid('无法解析该网页地址。');
  for (const address of addresses) {
    if (!isPublicAddress(address)) {
      throw invalid('出于安全原因，不能读取本机或内网地址。');
    }
  }

  url.hash = '';
  return url.toString();
}

export { isPublicAddress };

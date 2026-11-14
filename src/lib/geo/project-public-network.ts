import { lookup, Resolver } from 'node:dns/promises';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

export type PublicProjectAddress = { address: string; family: number };
export class PublicProjectNetworkError extends Error {}

/** Conservatively accept only globally routable addresses, including for every redirect. */
export function isPublicProjectAddress(address: string): boolean {
  const host = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host) === 4) {
    const [a, b, c] = host.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (isIP(host) === 6) {
    const normalized = new URL(`http://[${host}]/`).hostname.slice(1, -1);
    const [first, second = '0'] = normalized.split(':');
    const prefix = Number.parseInt(second || '0', 16);
    return /^[23][0-9a-f]{3}:/.test(normalized) && !(first === '2001' && (prefix < 0x200 || prefix === 0xdb8)) &&
      first !== '2002' && !(first === '3fff' && prefix <= 0x0fff);
  }
  return false;
}

function isProxyFakeAddress(address: string): boolean {
  if (isIP(address) === 4) return /^198\.(18|19)\./.test(address);
  if (isIP(address) === 6) {
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    // Some local proxy resolvers return the IPv6 benchmark range alongside 198.18/15.
    // This only permits public re-resolution; neither placeholder may be connected to.
    return normalized.startsWith('2001:2::') || normalized.startsWith('2001:2:0:');
  }
  return false;
}

export type PublicProjectDnsRuntime = {
  system: (hostname: string) => Promise<PublicProjectAddress[]>;
  publicDns: (hostname: string) => Promise<string[]>;
  trustedDoh: (hostname: string) => Promise<string[]>;
};

/** Fixed public resolver, pinned without local DNS; TLS still verifies cloudflare-dns.com. */
function resolveTrustedDoh(hostname: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const url = new URL('https://cloudflare-dns.com/dns-query');
    url.searchParams.set('name', hostname);
    url.searchParams.set('type', 'A');
    const fixedLookup: LookupFunction = (_hostname, options, callback) => {
      if (typeof options === 'object' && options.all) callback(null, [{ address: '1.1.1.1', family: 4 }]);
      else callback(null, '1.1.1.1', 4);
    };
    const req = https.get(url, { agent: false, lookup: fixedLookup,
      headers: { accept: 'application/dns-json', 'accept-encoding': 'identity' } }, response => {
      if (response.statusCode !== 200) {
        response.destroy();
        reject(new PublicProjectNetworkError('公共域名解析服务暂时不可用。'));
        return;
      }
      let bytes = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 65_536) response.destroy(new PublicProjectNetworkError('公共域名解析返回过大。'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { Status?: number; Answer?: { type?: number; data?: string }[] };
          if (data.Status !== 0 || !Array.isArray(data.Answer)) throw new Error('No public DNS answer');
          resolve(data.Answer.filter(answer => answer.type === 1 && typeof answer.data === 'string').map(answer => answer.data!));
        } catch { reject(new PublicProjectNetworkError('公共域名解析未返回有效地址。')); }
      });
    });
    const timer = setTimeout(() => req.destroy(new PublicProjectNetworkError('公共域名解析超时。')), 5000);
    req.on('error', reject);
    req.on('close', () => clearTimeout(timer));
  });
}

const defaultRuntime: PublicProjectDnsRuntime = {
  system: hostname => lookup(hostname, { all: true, verbatim: true }),
  publicDns: async hostname => {
    const resolver = new Resolver({ timeout: 1500, tries: 1 });
    resolver.setServers(['1.1.1.1']);
    return resolver.resolve4(hostname);
  },
  trustedDoh: resolveTrustedDoh,
};

function publicAnswers(addresses: string[]): PublicProjectAddress[] | undefined {
  if (!addresses.length || addresses.some(address => isIP(address) !== 4 || !isPublicProjectAddress(address))) return;
  return [...new Set(addresses)].map(address => ({ address, family: 4 }));
}

/** Only a known fake-IP DNS response permits re-resolution; private answers always fail closed. */
export async function lookupPublicProjectHost(hostname: string, runtime: PublicProjectDnsRuntime = defaultRuntime): Promise<PublicProjectAddress[]> {
  const literal = isIP(hostname);
  if (literal) {
    if (!isPublicProjectAddress(hostname)) throw new PublicProjectNetworkError('入口或跳转域名指向非公开地址，无法安全读取。');
    return [{ address: hostname, family: literal }];
  }
  if (!/^[a-z0-9.-]+$/i.test(hostname) || !hostname.includes('.') || /\.(localhost|local|internal|lan|home|test|invalid)$/i.test(hostname)) {
    throw new PublicProjectNetworkError('请使用公开网站域名。');
  }
  let addresses: PublicProjectAddress[];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    addresses = await Promise.race([runtime.system(hostname), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('DNS timeout')), 5000);
    })]);
  }
  catch { throw new PublicProjectNetworkError('暂时无法解析入口域名，请检查链接后重试。'); }
  finally { if (timer) clearTimeout(timer); }
  if (addresses.length && addresses.every(item => isPublicProjectAddress(item.address))) return addresses;
  if (!addresses.length || !addresses.every(item => isProxyFakeAddress(item.address))) {
    throw new PublicProjectNetworkError('入口或跳转域名指向非公开地址，无法安全读取。');
  }
  // Never connect to either placeholder range. Recover the real address via a separate public resolver.
  let resolved: string[] | undefined;
  try { resolved = await runtime.publicDns(hostname); }
  catch { /* Local proxy DNS interception or blocked UDP; try fixed HTTPS DNS once. */ }
  if (resolved?.length) {
    const direct = publicAnswers(resolved);
    if (direct) return direct;
    if (!resolved.every(isProxyFakeAddress)) throw new PublicProjectNetworkError('公共 DNS 返回非公开地址，无法安全读取。');
  }
  try {
    const trusted = publicAnswers(await runtime.trustedDoh(hostname));
    if (trusted) return trusted;
  } catch { /* Preserve only the safe, actionable error below. */ }
  throw new PublicProjectNetworkError('本机 DNS 返回代理占位地址，公共 DNS 也未能确认真实公开地址；请检查网络代理后重试。');
}

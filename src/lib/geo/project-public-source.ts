import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import zlib from 'node:zlib';
import { translateServerCode, type ServerErrorParams } from './i18n-server';
import { isPublicProjectAddress, normalizeProjectEntryUrl } from './project-onboarding-store';
import { lookupPublicProjectHost, PublicProjectNetworkError } from './project-public-network';

export class PublicSourceError extends Error {
  constructor(
    public code: string,
    public params?: ServerErrorParams,
    public status = 400,
    public detail?: string,
  ) {
    super(translateServerCode('zh', code, params));
  }
}
type Address = { address: string; family: number };
type SourceResponse = { status: number; headers: Record<string, string | undefined>; body: string };
export type PublicSourceRuntime = {
  lookup: (hostname: string) => Promise<Address[]>;
  request: (url: URL, address: Address, signal: AbortSignal, maxBytes: number, accept: string) => Promise<SourceResponse>;
};
export type PublicSource = { url: string; text: string; contentType: string; readAt: string };

const SUPPORTED_ENCODINGS = new Set(['', 'identity', 'gzip', 'x-gzip', 'deflate', 'br']);

function decompressWithTransform(
  raw: Buffer,
  createTransform: () => zlib.Gunzip | zlib.Inflate | zlib.InflateRaw | zlib.BrotliDecompress,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const transform = createTransform();
    const out: Buffer[] = [];
    let outBytes = 0;
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      transform.destroy();
      reject(err);
    };

    transform.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxBytes) {
        fail(new PublicSourceError('page_unreadable', { reason: 'too_large' }));
        return;
      }
      out.push(chunk);
    });
    transform.on('error', (err) => fail(err));
    transform.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(out));
    });
    transform.end(raw);
  });
}

export async function decodeCompressedBody(raw: Buffer, encodingHeader: string | undefined, maxBytes: number): Promise<string> {
  const normalized = (encodingHeader ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'identity') {
    return raw.toString('utf8');
  }
  if (!SUPPORTED_ENCODINGS.has(normalized)) {
    throw new PublicSourceError('page_unreadable', { reason: 'unsupported_encoding' });
  }
  try {
    if (normalized === 'gzip' || normalized === 'x-gzip') {
      return (await decompressWithTransform(raw, () => zlib.createGunzip(), maxBytes)).toString('utf8');
    }
    if (normalized === 'br') {
      return (await decompressWithTransform(raw, () => zlib.createBrotliDecompress(), maxBytes)).toString('utf8');
    }
    try {
      return (await decompressWithTransform(raw, () => zlib.createInflate(), maxBytes)).toString('utf8');
    } catch (error) {
      if (error instanceof PublicSourceError) throw error;
      return (await decompressWithTransform(raw, () => zlib.createInflateRaw(), maxBytes)).toString('utf8');
    }
  } catch (error) {
    if (error instanceof PublicSourceError) throw error;
    throw new PublicSourceError('page_unreadable', { reason: 'unsupported_encoding' });
  }
}

/** Pin the validated DNS answer to the connection; never perform a second DNS lookup. */
const request: PublicSourceRuntime['request'] = (url, address, signal, maxBytes, accept) => new Promise((resolve, reject) => {
  const transport = url.protocol === 'https:' ? https : http;
  const pinnedLookup: LookupFunction = (_host, options, callback) => {
    if (typeof options === 'object' && options.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  };
  const req = transport.request(url, { method: 'GET', agent: false, signal, lookup: pinnedLookup,
    headers: { Accept: accept, 'Accept-Encoding': 'gzip, deflate, br', 'User-Agent': 'OpenGEO public project reader' } }, (response) => {
    const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) =>
      [key, Array.isArray(value) ? value.join(', ') : value]));
    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      response.destroy();
      resolve({ status, headers, body: '' });
      return;
    }
    if (Number(headers['content-length'] || 0) > maxBytes) {
      response.destroy();
      reject(new PublicSourceError('page_unreadable', { reason: 'too_large' }));
      return;
    }
    const contentEncoding = (headers['content-encoding'] ?? '').trim().toLowerCase();
    if (contentEncoding && !SUPPORTED_ENCODINGS.has(contentEncoding)) {
      response.destroy();
      reject(new PublicSourceError('page_unreadable', { reason: 'unsupported_encoding' }));
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    response.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        response.destroy(new PublicSourceError('page_unreadable', { reason: 'too_large' }));
      } else chunks.push(chunk);
    });
    response.on('error', reject);
    response.on('end', () => {
      void decodeCompressedBody(Buffer.concat(chunks), contentEncoding, maxBytes)
        .then((body) => resolve({ status, headers, body }))
        .catch(reject);
    });
  });
  req.on('error', reject);
  req.end();
});

const defaultRuntime: PublicSourceRuntime = {
  lookup: lookupPublicProjectHost, request,
};

function validatePublicFetchUrl(value: string): URL {
  // Reuse normalizeProjectEntryUrl for every security invariant (scheme, credentials,
  // private/reserved hosts, ports, secret query parameters, tracking cleanup), while
  // preserving trailing slashes required by servers that canonicalize directory URLs.
  const normalized = new URL(normalizeProjectEntryUrl(value));
  const original = new URL(value.trim());
  if (original.pathname.endsWith('/') && !normalized.pathname.endsWith('/')) {
    normalized.pathname = `${normalized.pathname}/`;
  }
  return normalized;
}

export async function readPublicSource(value: string,
  options: { maxBytes: number; timeoutMs: number; maxRedirects?: number; accept?: string },
  runtime: PublicSourceRuntime = defaultRuntime): Promise<PublicSource> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const interrupted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () =>
    reject(new PublicSourceError('page_unreadable', { reason: 'timeout' })), { once: true }));
  try {
    return await Promise.race([(async () => {
      let url = validatePublicFetchUrl(value);
      for (let redirects = 0; redirects <= (options.maxRedirects ?? 3); redirects += 1) {
        controller.signal.throwIfAborted();
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await runtime.lookup(hostname);
        controller.signal.throwIfAborted();
        if (!addresses.length || addresses.some(item => !isPublicProjectAddress(item.address))) {
          throw new PublicSourceError('page_unreadable', { reason: 'private_address' });
        }
        const response = await runtime.request(url, addresses[0], controller.signal, options.maxBytes,
          options.accept ?? 'text/html, text/plain, text/markdown, application/json;q=0.9');
        controller.signal.throwIfAborted();
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (!response.headers.location) throw new PublicSourceError('page_unreadable', { reason: 'bad_redirect' });
          url = validatePublicFetchUrl(new URL(response.headers.location, url).href);
          continue;
        }
        if ([401, 403, 429].includes(response.status)) throw new PublicSourceError('page_unreadable', { reason: 'login_or_blocked' });
        if (response.status === 404) throw new PublicSourceError('page_unreadable', { reason: 'not_found' });
        if (response.status < 200 || response.status >= 300) throw new PublicSourceError('page_unreadable', { reason: 'http_status', status: response.status });
        if (Buffer.byteLength(response.body, 'utf8') > options.maxBytes) throw new PublicSourceError('page_unreadable', { reason: 'too_large' });
        const contentType = response.headers['content-type'] ?? '';
        if (contentType && !/text\/|application\/(?:[\w.+-]*json|xhtml\+xml)/i.test(contentType)) {
          throw new PublicSourceError('page_unreadable', { reason: 'non_text' });
        }
        return { url: url.href, text: response.body, contentType, readAt: new Date().toISOString() };
      }
      throw new PublicSourceError('page_unreadable', { reason: 'bad_redirect' });
    })(), interrupted]);
  } catch (error) {
    if (error instanceof PublicSourceError) throw error;
    if (error instanceof PublicProjectNetworkError) throw new PublicSourceError('page_unreadable', { reason: 'private_address' }, 400, error.message);
    if (controller.signal.aborted) throw new PublicSourceError('page_unreadable', { reason: 'timeout' });
    // Network exceptions can include sensitive request details; only safe messages leave this boundary.
    throw new PublicSourceError('page_unreadable');
  } finally { clearTimeout(timeout); }
}

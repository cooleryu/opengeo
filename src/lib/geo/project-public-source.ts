import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import zlib from 'node:zlib';
import { isPublicProjectAddress, normalizeProjectEntryUrl } from './project-onboarding-store';
import { lookupPublicProjectHost, PublicProjectNetworkError } from './project-public-network';

export class PublicSourceError extends Error {}
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
        fail(new PublicSourceError('公开页面超过读取大小上限，未截断为完整资料。'));
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
    throw new PublicSourceError('网站返回了暂不支持的压缩格式，未读取正文。');
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
    throw new PublicSourceError('公开页面解压失败，未读取正文。');
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
      reject(new PublicSourceError('公开页面超过读取大小上限，未截断为完整资料。'));
      return;
    }
    const contentEncoding = (headers['content-encoding'] ?? '').trim().toLowerCase();
    if (contentEncoding && !SUPPORTED_ENCODINGS.has(contentEncoding)) {
      response.destroy();
      reject(new PublicSourceError('网站返回了暂不支持的压缩格式，未读取正文。'));
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    response.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        response.destroy(new PublicSourceError('公开页面超过读取大小上限，未截断为完整资料。'));
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

export async function readPublicSource(value: string,
  options: { maxBytes: number; timeoutMs: number; maxRedirects?: number; accept?: string },
  runtime: PublicSourceRuntime = defaultRuntime): Promise<PublicSource> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const interrupted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () =>
    reject(new PublicSourceError('公开资料读取超时，请稍后重新尝试。')), { once: true }));
  try {
    return await Promise.race([(async () => {
      let url = new URL(normalizeProjectEntryUrl(value));
      for (let redirects = 0; redirects <= (options.maxRedirects ?? 3); redirects += 1) {
        controller.signal.throwIfAborted();
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await runtime.lookup(hostname);
        controller.signal.throwIfAborted();
        if (!addresses.length || addresses.some(item => !isPublicProjectAddress(item.address))) {
          throw new PublicSourceError('入口或跳转域名指向非公开地址，无法安全读取。');
        }
        const response = await runtime.request(url, addresses[0], controller.signal, options.maxBytes,
          options.accept ?? 'text/html, text/plain, text/markdown, application/json;q=0.9');
        controller.signal.throwIfAborted();
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (!response.headers.location) throw new PublicSourceError('页面跳转缺少目标地址。');
          url = new URL(normalizeProjectEntryUrl(new URL(response.headers.location, url).href));
          continue;
        }
        if ([401, 403, 429].includes(response.status)) throw new PublicSourceError('网站要求登录、限制访问或触发访问验证，未能读取公开正文。');
        if (response.status === 404) throw new PublicSourceError('没有找到公开页面或仓库 README，请检查入口是否公开。');
        if (response.status < 200 || response.status >= 300) throw new PublicSourceError(`公开页面读取失败（HTTP ${response.status}）。`);
        if (Buffer.byteLength(response.body, 'utf8') > options.maxBytes) throw new PublicSourceError('公开页面超过读取大小上限，未截断为完整资料。');
        const contentType = response.headers['content-type'] ?? '';
        if (contentType && !/text\/|application\/(?:[\w.+-]*json|xhtml\+xml)/i.test(contentType)) {
          throw new PublicSourceError('入口不是可读取的文字页面，请提供公开介绍页或仓库。');
        }
        return { url: url.href, text: response.body, contentType, readAt: new Date().toISOString() };
      }
      throw new PublicSourceError('页面跳转次数过多，未继续读取。');
    })(), interrupted]);
  } catch (error) {
    if (error instanceof PublicSourceError) throw error;
    if (error instanceof PublicProjectNetworkError) throw new PublicSourceError(error.message);
    if (controller.signal.aborted) throw new PublicSourceError('公开资料读取超时，请稍后重新尝试。');
    // Network exceptions can include sensitive request details; only safe messages leave this boundary.
    throw new PublicSourceError('无法安全读取公开资料，请检查链接、网络和网站访问限制。');
  } finally { clearTimeout(timeout); }
}

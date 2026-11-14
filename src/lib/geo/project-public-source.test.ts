import assert from 'node:assert/strict';
import { test } from 'node:test';
import zlib from 'node:zlib';
import {
  decodeCompressedBody,
  readPublicSource,
  type PublicSourceRuntime,
} from './project-public-source';

const options = { maxBytes: 1024, timeoutMs: 1000 };
const publicAddress = { address: '93.184.215.14', family: 4 };
const success = { status: 200, headers: { 'content-type': 'text/plain' }, body: 'Public project material.' };

test('validates all DNS answers and passes a pinned address to each request', async () => {
  const calls: string[] = [];
  const runtime: PublicSourceRuntime = {
    lookup: async hostname => { calls.push(`lookup:${hostname}`); return [publicAddress]; },
    request: async (url, address, _signal, maxBytes) => {
      calls.push(`request:${url.hostname}`);
      assert.deepEqual(address, publicAddress);
      assert.equal(maxBytes, options.maxBytes);
      return url.hostname === 'www.example.com' ? { status: 302, headers: { location: 'https://docs.example.com/intro' }, body: '' } : success;
    },
  };
  const source = await readPublicSource('https://www.example.com/', options, runtime);
  assert.equal(source.url, 'https://docs.example.com/intro');
  assert.deepEqual(calls, ['lookup:www.example.com', 'request:www.example.com', 'lookup:docs.example.com', 'request:docs.example.com']);
});

test('rejects mixed public/private DNS and redirects to private addresses before requesting', async () => {
  let requests = 0;
  await assert.rejects(() => readPublicSource('https://www.example.com/', options, {
    lookup: async () => [publicAddress, { address: '127.0.0.1', family: 4 }],
    request: async () => { requests += 1; return success; },
  }), /非公开地址/);
  assert.equal(requests, 0);
  await assert.rejects(() => readPublicSource('https://www.example.com/', options, {
    lookup: async hostname => hostname === 'metadata.example.com' ? [{ address: '169.254.169.254', family: 4 }] : [publicAddress],
    request: async () => { requests += 1; return { status: 302, headers: { location: 'https://metadata.example.com/' }, body: '' }; },
  }), /非公开地址/);
  assert.equal(requests, 1);
});

test('limits size, redirects and reading time and never exposes network exception details', async () => {
  const runtime: PublicSourceRuntime = { lookup: async () => [publicAddress], request: async () => success };
  await assert.rejects(() => readPublicSource('https://www.example.com/', options, {
    ...runtime, request: async () => ({ ...success, body: 'x'.repeat(1025) }),
  }), /大小上限/);
  await assert.rejects(() => readPublicSource('https://www.example.com/', { ...options, maxRedirects: 1 }, {
    ...runtime, request: async () => ({ status: 302, headers: { location: '/next' }, body: '' }),
  }), /跳转次数/);
  await assert.rejects(() => readPublicSource('https://www.example.com/', { ...options, timeoutMs: 10 }, {
    ...runtime, lookup: () => new Promise(() => {}),
  }), /超时/);
  await assert.rejects(() => readPublicSource('https://www.example.com/', options, {
    ...runtime, request: async () => { throw new Error('Authorization: secret-should-not-leak'); },
  }), error => error instanceof Error && !error.message.includes('secret-should-not-leak'));
});

test('decompresses gzip, deflate, and br bodies safely and rejects decompressed payloads exceeding maxBytes', async () => {
  const plainText = '<html><body><h1>Winner Guide</h1><p>Structured content wins citations.</p></body></html>';
  const gzipBuf = zlib.gzipSync(Buffer.from(plainText));
  const brBuf = zlib.brotliCompressSync(Buffer.from(plainText));
  const deflateBuf = zlib.deflateSync(Buffer.from(plainText));
  const deflateRawBuf = zlib.deflateRawSync(Buffer.from(plainText));

  assert.equal(await decodeCompressedBody(gzipBuf, 'gzip', 4096), plainText);
  assert.equal(await decodeCompressedBody(gzipBuf, 'x-gzip', 4096), plainText);
  assert.equal(await decodeCompressedBody(brBuf, 'br', 4096), plainText);
  assert.equal(await decodeCompressedBody(deflateBuf, 'deflate', 4096), plainText);
  assert.equal(await decodeCompressedBody(deflateRawBuf, 'deflate', 4096), plainText);

  const bomb = zlib.gzipSync(Buffer.alloc(2048, 'a'));
  await assert.rejects(() => decodeCompressedBody(bomb, 'gzip', 512), /大小上限/);
  await assert.rejects(() => decodeCompressedBody(Buffer.from(plainText), 'zstd', 4096), /暂不支持的压缩格式/);
});

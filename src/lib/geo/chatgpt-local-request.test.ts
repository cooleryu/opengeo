import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { cookieHash, requireChatGPTLocalRequest } from './chatgpt-local-request';

const request = (headers: Record<string, string> = {}) => new Request('http://localhost:4327/api/geo/chatgpt', {
  method: 'POST', headers: { host: '127.0.0.1:4327', origin: 'http://127.0.0.1:4327',
    'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
});
test('accepts actual Next normalized URL but only literal loopback authority', () => {
  assert.doesNotThrow(() => requireChatGPTLocalRequest(request(), true));
  for (const host of ['example.com', 'localhost:4327', '127.0.0.1.evil.test', '127.0.0.1:4327@evil.test']) {
    assert.throws(() => requireChatGPTLocalRequest(request({ host }), true));
  }
});
test('rejects cross-origin, cross-site, missing Origin, and form submissions', () => {
  const cases: Array<Record<string, string>> = [{origin:'https://evil.test'}, {'sec-fetch-site':'cross-site'}, {origin:''}, {'content-type':'text/plain'}];
  for (const headers of cases) {
    assert.throws(() => requireChatGPTLocalRequest(request(headers), true));
  }
});
test('session parser hashes only a single well-formed bearer cookie', () => {
  const secret = 's'.repeat(43);
  assert.equal(cookieHash(request({cookie:`session=${secret}`}), 'session'), createHash('sha256').update(secret).digest('hex'));
  assert.equal(cookieHash(request({cookie:`session=${secret}; session=${secret}`}), 'session'), '');
  assert.equal(cookieHash(request({cookie:'session=short'}), 'session'), '');
  assert.equal(cookieHash(request(), 'session'), '');
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import { disconnectChatGPT, getChatGPTAccess, getChatGPTStatus, isChatGPTBrowserSession, listChatGPTModels,
  selectChatGPTModel, setChatGPTAnalysisEnabled, startChatGPTSignIn } from './chatgpt-auth';
import { CHATGPT_PENDING_COOKIE, CHATGPT_SESSION_COOKIE } from './chatgpt-types';

const originalFetch = globalThis.fetch;
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'synthetic-key', use: 'sig', alg: 'RS256' };
const pendingCookie = Buffer.alloc(32, 1).toString('base64url');
const browserHash = createHash('sha256').update(pendingCookie).digest('hex');
const issuer = 'https://auth.openai.com';
let previousDataDir: string | undefined;
let temporary: string;
let authorize: URL;
let tokenCalls: URLSearchParams[];
let revokeCalls: URLSearchParams[];
let identityChanges: Record<string, unknown>;
let responseScope: string;
let invalidSignature: boolean;
let refreshFailure: boolean;
let codeExchangeFailure: boolean;
let revokeFailure: boolean;
let activeHash: string;

function signedIdentity() {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: issuer, aud: 'oaiapp_synthetic', sub: 'synthetic-subject', iat: now, exp: now + 3600,
    nonce: authorize.searchParams.get('nonce'), email: 'synthetic@example.test', ...identityChanges };
  const input = `${encode({ alg: 'RS256', kid: 'synthetic-key' })}.${encode(claims)}`;
  return `${input}.${invalidSignature ? Buffer.from('invalid').toString('base64url') : sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url')}`;
}
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
const privateDir = () => path.join(temporary, 'data/chatgpt-private');
const connectionFile = () => path.join(privateDir(), 'connection.json');
const saved = () => JSON.parse(fs.readFileSync(connectionFile(), 'utf8'));

beforeEach(() => {
  previousDataDir = process.env.DATA_DIR;
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-chatgpt-auth-'));
  process.env.DATA_DIR = temporary;
  tokenCalls = []; revokeCalls = []; identityChanges = {}; responseScope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
  invalidSignature = false; refreshFailure = false; codeExchangeFailure = false; revokeFailure = false; activeHash = '';
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.equal(init?.redirect, 'error', 'credentials must not follow redirects');
    if (url === `${issuer}/.well-known/openid-configuration`) return json({ issuer, jwks_uri: `${issuer}/.well-known/jwks.json`, revocation_endpoint: `${issuer}/oauth/revoke` });
    if (url === `${issuer}/.well-known/jwks.json`) return json({ keys: [jwk] });
    if (url === `${issuer}/api/accounts/oauth/token`) {
      const body = new URLSearchParams(String(init?.body));
      tokenCalls.push(body);
      assert.equal(body.get('client_id'), 'oaiapp_synthetic');
      assert.equal(body.get('resource'), 'https://api.openai.com/v1');
      assert.equal(body.has('client_secret'), false);
      if (body.get('grant_type') === 'refresh_token') {
        assert.equal(body.has('scope'), false);
        if (refreshFailure) return json({ error: 'invalid_grant', error_description: 'synthetic-private-provider-text' }, 400);
        return json({ access_token: 'synthetic-rotated-access', refresh_token: 'synthetic-rotated-refresh', token_type: 'Bearer', expires_in: 3600 });
      }
      assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'), authorize.searchParams.get('code_challenge'));
      assert.equal(body.get('redirect_uri'), authorize.searchParams.get('redirect_uri'));
      if (codeExchangeFailure) return json({ error: 'invalid_grant' }, 400);
      return json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', id_token: signedIdentity(), token_type: 'Bearer', expires_in: 3600, scope: responseScope });
    }
    if (url === 'https://api.openai.com/v1/models') {
      assert.match(new Headers(init?.headers).get('authorization') || '', /^Bearer synthetic-/);
      return json({ models: [{ slug: 'synthetic-first', display_name: 'First', visibility: 'list',
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }, { effort: 'low' }, { effort: 'not-an-api-effort' }, null], default_reasoning_level: 'low' },
        { slug: 'synthetic-hidden', display_name: 'Hidden', visibility: 'hidden' },
        { slug: 'synthetic-second', display_name: 'Second', visibility: 'list' }] });
    }
    if (url === `${issuer}/oauth/revoke`) {
      revokeCalls.push(new URLSearchParams(String(init?.body)));
      return new Response(null, { status: revokeFailure ? 503 : 200 });
    }
    throw new Error('Unexpected synthetic test network request');
  };
});

afterEach(async () => {
  try { await disconnectChatGPT(); } catch { /* Tests may intentionally make storage invalid. */ }
  globalThis.fetch = originalFetch;
  if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
  fs.rmSync(temporary, { force: true, recursive: true });
});

async function start(hash = browserHash) {
  authorize = new URL((await startChatGPTSignIn(hash)).authorizationUrl);
  return authorize;
}
async function callback(changes: Record<string, string> = {}, cookie = pendingCookie) {
  const url = new URL(authorize.searchParams.get('redirect_uri')!);
  url.search = new URLSearchParams({ state: authorize.searchParams.get('state')!, code: 'synthetic-code', client_id: 'oaiapp_synthetic', ...changes }).toString();
  const response = await originalFetch(url, { headers: { cookie: `${CHATGPT_PENDING_COOKIE}=${cookie}` } });
  const activeCookie = response.headers.getSetCookie().find(value => value.startsWith(`${CHATGPT_SESSION_COOKIE}=`))?.split(';')[0].slice(CHATGPT_SESSION_COOKIE.length + 1);
  if (activeCookie) activeHash = createHash('sha256').update(activeCookie).digest('hex');
  return response;
}
async function login() { await start(); const response = await callback(); assert.equal(response.status, 200); await response.text(); }

test('official PKCE loopback flow validates identity, stores privately, and exposes metadata only', async () => {
  assert.equal(getChatGPTStatus().connected, false);
  await start();
  assert.equal(authorize.origin + authorize.pathname, `${issuer}/api/accounts/authorize`);
  assert.equal(authorize.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(authorize.searchParams.get('agent_name_hint'), 'OpenGEO');
  assert.equal(authorize.searchParams.get('scope'), responseScope);
  assert.equal(authorize.searchParams.has('id_token_hint'), false);
  assert.equal(authorize.searchParams.has('code_verifier'), false);
  const redirect = new URL(authorize.searchParams.get('redirect_uri')!);
  assert.equal(redirect.hostname, '127.0.0.1'); assert.equal(redirect.pathname, '/auth/callback');
  assert.equal(isChatGPTBrowserSession(browserHash), false);
  const wrongState = await callback({ state: 'incorrect' });
  assert.equal(wrongState.status, 400); await wrongState.text();
  assert.equal(tokenCalls.length, 0); assert.equal(getChatGPTStatus().pending, true);
  const success = await callback();
  const page = await success.text();
  assert.equal(success.status, 200); assert.equal(success.headers.get('cache-control'), 'no-store');
  assert.ok(page.includes('history.replaceState')); assert.ok(!page.includes('synthetic-code'));
  const status = getChatGPTStatus();
  assert.deepEqual(status, { connected: true, planEnabled: true, enabled: false, model: '', accountLabel: 'synthetic@example.test', pending: false });
  assert.equal(isChatGPTBrowserSession(browserHash), false, 'the pending browser secret never becomes the authorized secret');
  assert.equal(isChatGPTBrowserSession(activeHash), true);
  assert.notEqual(activeHash, browserHash);
  assert.equal(isChatGPTBrowserSession('f'.repeat(64)), false);
  assert.equal(JSON.stringify(status).includes('token'), false);
  assert.equal(fs.statSync(privateDir()).mode & 0o777, 0o700);
  assert.equal(fs.statSync(connectionFile()).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(privateDir()), ['connection.json']);
  assert.equal(saved().registration.clientId, 'oaiapp_synthetic');
});

test('model choices honor account visibility and explicit enable requires a chosen model', async () => {
  await login();
  await assert.rejects(() => setChatGPTAnalysisEnabled(true), /选择模型/);
  assert.deepEqual(await listChatGPTModels(), [{ id: 'synthetic-first', name: 'First', reasoningEfforts: ['low', 'max'], defaultReasoningEffort: 'low' }, { id: 'synthetic-second', name: 'Second' }]);
  await assert.rejects(() => selectChatGPTModel('synthetic-hidden'), /不在/);
  await selectChatGPTModel('synthetic-second');
  assert.equal((await setChatGPTAnalysisEnabled(true)).enabled, true);
  assert.deepEqual(await getChatGPTAccess(), { accessToken: 'synthetic-access', model: 'synthetic-second' });
});

test('reasoning effort is validated against the selected model, saved and reset safely', async () => {
  await login();
  const status = await selectChatGPTModel('synthetic-first', 'max');
  assert.equal(status.reasoningEffort, 'max');
  assert.equal(saved().reasoningEffort, 'max');
  assert.deepEqual(await getChatGPTAccess(), { accessToken: 'synthetic-access', model: 'synthetic-first', reasoningEffort: 'max' });
  await assert.rejects(() => selectChatGPTModel('synthetic-first', 'high'), /不支持/);
  await assert.rejects(() => selectChatGPTModel('synthetic-first', null), /不支持/);
  assert.equal(getChatGPTStatus().reasoningEffort, 'max', 'invalid updates do not overwrite the saved choice');
  await selectChatGPTModel('synthetic-first', 'default');
  assert.equal(getChatGPTStatus().reasoningEffort, undefined);
  await selectChatGPTModel('synthetic-first', 'max');
  await selectChatGPTModel('synthetic-second');
  assert.equal(getChatGPTStatus().reasoningEffort, undefined, 'switching to a model without effort support resets to provider default');
  await assert.rejects(() => selectChatGPTModel('synthetic-second', 'max'), /不支持/);
  assert.equal(fs.statSync(connectionFile()).mode & 0o777, 0o600);
});

test('an ID token without plan scope never enables inference', async () => {
  responseScope = 'openid profile email';
  await login();
  assert.equal(getChatGPTStatus().connected, true); assert.equal(getChatGPTStatus().planEnabled, false);
  await assert.rejects(() => listChatGPTModels(), /尚未授权/);
  await assert.rejects(() => setChatGPTAnalysisEnabled(true), /授权套餐/);
});

test('invalid signature and incorrect issuer, audience, nonce, expiry or subject are rejected', async () => {
  for (const change of [{}, { iss: 'https://attacker.example' }, { aud: 'oaiapp_wrong' }, { nonce: 'wrong' }, { exp: 1 }, { sub: '' }]) {
    identityChanges = change; invalidSignature = Object.keys(change).length === 0;
    await start();
    const response = await callback();
    assert.equal(response.status, 400); await response.text();
    assert.equal(getChatGPTStatus().connected, false);
    assert.equal(isChatGPTBrowserSession(browserHash), false);
    assert.equal(saved().credentials, undefined);
  }
});

test('missing issued client ID and denied consent cannot exchange a code', async () => {
  await start();
  const callbackUrl = new URL(authorize.searchParams.get('redirect_uri')!);
  callbackUrl.search = new URLSearchParams({ state: authorize.searchParams.get('state')!, code: 'synthetic-code' }).toString();
  let response = await originalFetch(callbackUrl, { headers: { cookie: `${CHATGPT_PENDING_COOKIE}=${pendingCookie}` } }); assert.equal(response.status, 400); await response.text();
  assert.equal(tokenCalls.length, 0);
  await start(); response = await callback({ error: 'access_denied' }); assert.equal(response.status, 400); await response.text();
  assert.equal(tokenCalls.length, 0);
});

test('concurrent near-expiry calls rotate credentials only once and preserve scopes', async () => {
  await login(); await selectChatGPTModel('synthetic-first');
  const record = saved(); record.credentials.expiresAt = Date.now() - 1; fs.writeFileSync(connectionFile(), JSON.stringify(record));
  const results = await Promise.all([getChatGPTAccess(), getChatGPTAccess(), getChatGPTAccess()]);
  assert.equal(tokenCalls.filter(call => call.get('grant_type') === 'refresh_token').length, 1);
  assert.ok(results.every(result => result.accessToken === 'synthetic-rotated-access'));
  assert.equal(saved().credentials.refreshToken, 'synthetic-rotated-refresh');
  assert.equal(getChatGPTStatus().planEnabled, true);
});

test('invalid refresh grant clears credentials and browser authorization with a generic error', async () => {
  await login(); await selectChatGPTModel('synthetic-first'); await setChatGPTAnalysisEnabled(true);
  const record = saved(); record.credentials.expiresAt = Date.now() - 1; fs.writeFileSync(connectionFile(), JSON.stringify(record));
  refreshFailure = true;
  await assert.rejects(() => getChatGPTAccess(), error => error instanceof Error && error.message.includes('重新登录') && !error.message.includes('private-provider'));
  assert.equal(getChatGPTStatus().connected, false); assert.equal(getChatGPTStatus().enabled, true, 'expired authorization preserves the chosen provider instead of silently switching');
  assert.equal(saved().credentials, undefined); assert.equal(saved().browserSessionHash, undefined);
});

test('signout revokes and retains registration, returning login rejects a different client or account', async () => {
  await login(); const hostId = saved().hostId;
  const result = await disconnectChatGPT();
  assert.equal(result.remoteRevocationConfirmed, true); assert.equal(result.status.connected, false);
  assert.equal(revokeCalls[0].get('token'), 'synthetic-refresh'); assert.equal(revokeCalls[0].get('client_id'), 'oaiapp_synthetic');
  assert.equal(saved().credentials, undefined); assert.equal(isChatGPTBrowserSession(browserHash), false);
  await start();
  assert.equal(authorize.searchParams.get('client_id'), 'oaiapp_synthetic');
  assert.equal(authorize.searchParams.get('ext_agent_host_id'), hostId);
  assert.equal(authorize.searchParams.has('agent_name_hint'), false);
  assert.equal(authorize.searchParams.has('login_hint'), false);
  assert.equal(authorize.searchParams.has('id_token_hint'), false);
  const mismatch = await callback({ client_id: 'oaiapp_other' }); assert.equal(mismatch.status, 400); await mismatch.text();
  assert.equal(tokenCalls.length, 1);
  await start(); identityChanges = { sub: 'another-subject' };
  const otherAccount = await callback(); assert.equal(otherAccount.status, 400); await otherAccount.text();
  assert.equal(saved().registration.subject, 'synthetic-subject'); assert.equal(saved().credentials, undefined);
});

test('a failed new login does not authorize its browser or disturb the active account', async () => {
  await login();
  const otherCookie = Buffer.alloc(32, 3).toString('base64url');
  const otherHash = createHash('sha256').update(otherCookie).digest('hex');
  await start(otherHash);
  assert.equal(isChatGPTBrowserSession(otherHash), false); assert.equal(isChatGPTBrowserSession(activeHash), true);
  identityChanges = { nonce: 'wrong' };
  const response = await callback({}, otherCookie); assert.equal(response.status, 400); await response.text();
  assert.equal(isChatGPTBrowserSession(otherHash), false); assert.equal(isChatGPTBrowserSession(activeHash), true);
  assert.equal(saved().credentials.accessToken, 'synthetic-access');
});

test('invalid code exchange retries the issued client instead of registering a duplicate', async () => {
  await start(); codeExchangeFailure = true;
  const failure = await callback(); assert.equal(failure.status, 400); await failure.text();
  assert.equal(saved().registration, undefined);
  await start();
  assert.equal(authorize.searchParams.get('client_id'), 'oaiapp_synthetic');
  assert.equal(authorize.searchParams.has('agent_name_hint'), false);
  codeExchangeFailure = false;
  const response = await callback(); assert.equal(response.status, 200); await response.text();
  assert.equal(getChatGPTStatus().connected, true);
});

test('failed remote revocation is disclosed while local tokens are cleared', async () => {
  await login(); revokeFailure = true;
  const result = await disconnectChatGPT();
  assert.equal(result.remoteRevocationConfirmed, false); assert.equal(result.status.connected, false);
  assert.match(result.status.error || '', /未确认远端撤销/); assert.equal(saved().credentials, undefined);
  assert.equal(revokeCalls.length, 2);
});

test('state alone cannot complete login without the initiating browser cookie', async () => {
  await start();
  const response = await callback({}, Buffer.alloc(32, 2).toString('base64url'));
  assert.equal(response.status, 400); await response.text();
  assert.equal(tokenCalls.length, 0); assert.equal(getChatGPTStatus().pending, true);
  assert.equal(getChatGPTStatus().connected, false);
});

test('credential file and directory symlinks are rejected without reading their target', async () => {
  fs.mkdirSync(path.join(temporary, 'data'));
  const outside = path.join(temporary, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, privateDir());
  assert.throws(() => getChatGPTStatus(), /无法安全/);
  fs.unlinkSync(privateDir()); fs.mkdirSync(privateDir());
  const secret = path.join(outside, 'secret'); fs.writeFileSync(secret, 'synthetic-secret-content');
  fs.symlinkSync(secret, connectionFile());
  assert.throws(() => getChatGPTStatus(), error => error instanceof Error && !error.message.includes('synthetic-secret-content'));
  assert.equal(fs.readFileSync(secret, 'utf8'), 'synthetic-secret-content');
});

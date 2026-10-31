// Node-only module: never import this from a client component. Public types live separately.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { ChatGPTModel, ChatGPTStatus, ChatGPTReasoningEffort } from './chatgpt-types';
import { CHATGPT_PENDING_COOKIE, CHATGPT_SESSION_COOKIE, isChatGPTReasoningEffort } from './chatgpt-types';

if (typeof window !== 'undefined') throw new Error('ChatGPT credentials are server-only.');

const ISSUER = 'https://auth.openai.com';
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = 'https://api.openai.com/v1';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const STORAGE_ERROR = '无法安全读取或保存 ChatGPT 连接，请检查本地数据目录。';

export class ChatGPTAuthError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.name = 'ChatGPTAuthError'; this.status = status; }
}

type Registration = { clientId: string; subject: string; email: string };
type Credentials = { accessToken: string; refreshToken: string; idToken: string; expiresAt: number; scopes: string[] };
type Saved = { version: 1; hostId: string; registration?: Registration; credentials?: Credentials; model: string; enabled: boolean;
  reasoningEffort?: ChatGPTReasoningEffort;
  browserSessionHash?: string; browserSessionExpiresAt?: number };
type Attempt = {
  state: string; nonce: string; verifier: string; redirectUri: string; registration?: Registration;
  requestedClientId: string;
  server: Server; timeout: ReturnType<typeof setTimeout>; consumed: boolean;
};
type Runtime = { attempt?: Attempt; error?: string; starting?: boolean; stopping?: boolean; retryClientId?: string };
const shared = globalThis as typeof globalThis & { __opengeoChatGPTAuth?: Map<string, Runtime> };
const runtimes = shared.__opengeoChatGPTAuth ??= new Map<string, Runtime>();
const directory = () => path.join(process.env.DATA_DIR || process.cwd(), 'data', 'chatgpt-private');
const runtime = (dir: string) => { if (!runtimes.has(dir)) runtimes.set(dir, {}); return runtimes.get(dir)!; };
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const cleanText = (value: unknown, maximum = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
const clientIdValid = (value: unknown): value is string => typeof value === 'string' && /^oaiapp_[A-Za-z0-9_-]{1,240}$/.test(value);
const random = () => randomBytes(32).toString('base64url');
const equal = (left: string, right: string) => left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));

function assertPath(file: string, kind: 'file' | 'directory', missing = false) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (kind === 'file' ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) throw new Error();
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error();
    return stat;
  } catch (error) {
    if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ChatGPTAuthError(STORAGE_ERROR, 500);
  }
}

function ensureDirectory(dir: string, create: boolean) {
  // DATA_DIR is the existing app convention: <DATA_DIR>/data, not DATA_DIR itself.
  const base = path.dirname(path.dirname(dir));
  assertPath(base, 'directory');
  for (const item of [path.dirname(dir), dir]) {
    if (!assertPath(item, 'directory', true)) {
      if (!create) return false;
      try { fs.mkdirSync(item, { mode: 0o700 }); } catch { throw new ChatGPTAuthError(STORAGE_ERROR, 500); }
    }
  }
  // Only change permissions on our own private directory, never on the shared data directory.
  try { fs.chmodSync(dir, 0o700); } catch { throw new ChatGPTAuthError(STORAGE_ERROR, 500); }
  return true;
}

function readSaved(dir: string): Saved {
  const empty: Saved = { version: 1, hostId: '', model: '', enabled: false };
  if (!ensureDirectory(dir, false)) return empty;
  const file = path.join(dir, 'connection.json');
  if (!assertPath(file, 'file', true)) return empty;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let saved: Saved;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 128 * 1024) throw new Error();
      fs.fchmodSync(fd, 0o600);
      saved = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally { fs.closeSync(fd); }
    if (!isObject(saved) || saved.version !== 1 || !cleanText(saved.hostId) || typeof saved.model !== 'string' || typeof saved.enabled !== 'boolean' ||
      (saved.browserSessionHash !== undefined && !/^[a-f0-9]{64}$/.test(saved.browserSessionHash)) ||
      (saved.reasoningEffort !== undefined && !isChatGPTReasoningEffort(saved.reasoningEffort))) throw new Error();
    const registration = saved.registration;
    if (registration && (!clientIdValid(registration.clientId) || !cleanText(registration.subject) || typeof registration.email !== 'string')) throw new Error();
    const credentials = saved.credentials;
    if (credentials && (!registration || !cleanText(credentials.accessToken, 32768) || !cleanText(credentials.idToken, 32768) ||
      typeof credentials.refreshToken !== 'string' || !Number.isFinite(credentials.expiresAt) || !Array.isArray(credentials.scopes) ||
      !credentials.scopes.every((item) => cleanText(item)))) throw new Error();
    return saved;
  } catch { throw new ChatGPTAuthError(STORAGE_ERROR, 500); }
}

function writeSaved(dir: string, saved: Saved) {
  ensureDirectory(dir, true);
  const file = path.join(dir, 'connection.json');
  assertPath(file, 'file', true);
  const temporary = path.join(dir, `${randomUUID()}.tmp`);
  try {
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(saved)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } catch { throw new ChatGPTAuthError(STORAGE_ERROR, 500); }
  finally { try { fs.unlinkSync(temporary); } catch { /* Already renamed or never created. */ } }
}

// Cross-process lock is necessary for rotating refresh tokens (including Next dev workers).
async function locked<T>(dir: string, action: () => Promise<T> | T): Promise<T> {
  ensureDirectory(dir, true);
  const lock = path.join(dir, 'session.lock');
  const deadline = Date.now() + 25_000;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      assertPath(lock, 'file', true);
      fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, String(process.pid));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new ChatGPTAuthError(STORAGE_ERROR, 500);
      try {
        const pid = Number(fs.readFileSync(lock, 'utf8'));
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ESRCH') fs.unlinkSync(lock); }
        }
      } catch { /* An active writer or another contender may have removed it. */ }
      if (Date.now() >= deadline) throw new ChatGPTAuthError('ChatGPT 连接正在更新，请稍后重试。', 409);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try { return await action(); }
  finally { fs.closeSync(fd); try { fs.unlinkSync(lock); } catch { /* No credentials in lock. */ } }
}

function publicStatus(saved: Saved, local: Runtime): ChatGPTStatus {
  const connected = !!saved.credentials && (!!saved.credentials.refreshToken || saved.credentials.expiresAt > Date.now());
  return { connected, planEnabled: connected && !!saved.credentials?.scopes.includes(PLAN_SCOPE), enabled: saved.enabled,
    model: saved.model, ...(saved.reasoningEffort ? { reasoningEffort: saved.reasoningEffort } : {}),
    accountLabel: saved.registration?.email || (saved.registration ? 'ChatGPT 账号' : ''),
    pending: !!local.attempt, ...(local.error ? { error: local.error } : {}) };
}

export function getChatGPTStatus(): ChatGPTStatus { const dir = directory(); return publicStatus(readSaved(dir), runtime(dir)); }

/** Bind privileged UI routes to the browser that completed the official OAuth flow. */
export function isChatGPTBrowserSession(hash: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(hash)) return false;
  const dir = directory();
  const saved = readSaved(dir);
  return !!saved.browserSessionHash && typeof saved.browserSessionExpiresAt === 'number' && saved.browserSessionExpiresAt > Date.now() &&
    publicStatus(saved, runtime(dir)).connected && equal(saved.browserSessionHash, hash);
}

async function request(url: string, init: RequestInit = {}): Promise<Response> {
  try { return await fetch(url, { ...init, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20_000) }); }
  catch { throw new ChatGPTAuthError('无法连接 ChatGPT 官方服务，请稍后重试。', 502); }
}

async function json(response: Response): Promise<Record<string, unknown>> {
  try {
    const text = await response.text();
    if (text.length > 1_000_000) throw new Error();
    const value: unknown = JSON.parse(text);
    if (!isObject(value)) throw new Error();
    return value;
  } catch { throw new ChatGPTAuthError('ChatGPT 官方服务返回了无法识别的数据，请重试。', 502); }
}

function officialEndpoint(value: unknown): string {
  if (typeof value !== 'string') throw new ChatGPTAuthError('无法验证 ChatGPT 官方服务。', 502);
  try {
    const url = new URL(value);
    if (url.origin !== ISSUER || url.username || url.password || url.hash) throw new Error();
    return url.href;
  } catch { throw new ChatGPTAuthError('无法验证 ChatGPT 官方服务。', 502); }
}

async function discovery() {
  const response = await request(`${ISSUER}/.well-known/openid-configuration`);
  if (!response.ok) throw new ChatGPTAuthError('无法验证 ChatGPT 官方服务。', 502);
  const value = await json(response);
  if (value.issuer !== ISSUER) throw new ChatGPTAuthError('无法验证 ChatGPT 官方服务。', 502);
  return value;
}

async function verifyIdentity(token: unknown, clientId: string, nonce?: string): Promise<{ subject: string; email: string }> {
  const invalid = () => new ChatGPTAuthError('ChatGPT 身份验证未通过，请重新登录。', 401);
  if (!cleanText(token, 32768)) throw invalid();
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw invalid();
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (!isObject(header) || header.alg !== 'RS256' || !cleanText(header.kid) || header.crit !== undefined || !isObject(claims)) throw invalid();
    const metadata = await discovery();
    const response = await request(officialEndpoint(metadata.jwks_uri));
    if (!response.ok) throw invalid();
    const keys = (await json(response)).keys;
    if (!Array.isArray(keys)) throw invalid();
    const matches = keys.filter(key => isObject(key) && key.kid === header.kid && key.kty === 'RSA' && (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256'));
    if (matches.length !== 1) throw invalid();
    const key = createPublicKey({ key: matches[0], format: 'jwk' });
    if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) throw invalid();
    const now = Date.now() / 1000;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== ISSUER || !audiences.includes(clientId) || (audiences.length > 1 && claims.azp !== clientId) ||
      (claims.azp !== undefined && claims.azp !== clientId) || typeof claims.exp !== 'number' || claims.exp <= now - 5 ||
      typeof claims.iat !== 'number' || claims.iat > now + 5 || (typeof claims.nbf === 'number' && claims.nbf > now + 5) ||
      !cleanText(claims.sub) || (nonce !== undefined && (typeof claims.nonce !== 'string' || !equal(claims.nonce, nonce)))) throw invalid();
    return { subject: claims.sub, email: cleanText(claims.email, 320) ? claims.email : '' };
  } catch (error) { if (error instanceof ChatGPTAuthError) throw error; throw invalid(); }
}

async function tokenGrant(body: URLSearchParams): Promise<Record<string, unknown>> {
  const response = await request(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const value = await json(response);
  if (!response.ok) throw new ChatGPTAuthError(value.error === 'invalid_grant' ? 'ChatGPT 授权已失效，请重新登录。' : 'ChatGPT 授权未完成，请重新登录。', value.error === 'invalid_grant' ? 401 : 502);
  return value;
}

function credentialsFrom(value: Record<string, unknown>, previous?: Credentials): Credentials {
  if (!cleanText(value.access_token, 32768) || typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer' ||
    typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in) || value.expires_in <= 0 ||
    (value.refresh_token !== undefined && !cleanText(value.refresh_token, 32768))) throw new ChatGPTAuthError('ChatGPT 授权数据不完整，请重新登录。', 502);
  const idToken = typeof value.id_token === 'string' ? value.id_token : previous?.idToken;
  if (!idToken || (value.scope !== undefined && typeof value.scope !== 'string')) throw new ChatGPTAuthError('ChatGPT 授权数据不完整，请重新登录。', 502);
  return { accessToken: value.access_token, refreshToken: typeof value.refresh_token === 'string' ? value.refresh_token : previous?.refreshToken || '',
    idToken, expiresAt: Date.now() + value.expires_in * 1000,
    scopes: typeof value.scope === 'string' ? value.scope.split(/\s+/).filter(Boolean) : previous?.scopes || [] };
}

function closeAttempt(local: Runtime) {
  if (!local.attempt) return;
  clearTimeout(local.attempt.timeout);
  local.attempt.server.close();
  local.attempt = undefined;
}

function callbackPage(response: ServerResponse, status: number, message: string, cookies: string[] = []) {
  const nonce = random();
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`,
    ...(cookies.length ? { 'Set-Cookie': cookies } : {}) });
  // Only app-authored messages; never interpolate callback parameters or upstream errors.
  response.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>OpenGEO · ChatGPT</title><script nonce="${nonce}">history.replaceState(null,'','/auth/done')</script><body><h1>${message}</h1><p>请返回 OpenGEO 设置页面。此窗口可以关闭。</p></body></html>`);
}

export async function startChatGPTSignIn(browserSessionHash: string): Promise<{ authorizationUrl: string }> {
  if (typeof browserSessionHash !== 'string' || !/^[a-f0-9]{64}$/.test(browserSessionHash)) throw new ChatGPTAuthError('本地登录会话无效，请重新打开设置。');
  const dir = directory();
  const local = runtime(dir);
  if (local.starting || local.stopping) throw new ChatGPTAuthError('ChatGPT 连接正在更新，请稍后重试。', 409);
  local.starting = true;
  try {
    closeAttempt(local); local.error = undefined;
    const saved = await locked(dir, () => {
      const current = readSaved(dir);
      if (!current.hostId) { current.hostId = `urn:uuid:${randomUUID()}`; writeSaved(dir, current); }
      return current;
    });
    const state = random(), nonce = random(), verifier = random();
    let attempt: Attempt;
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        if (req.method !== 'GET' || url.pathname !== '/auth/callback' || req.headers.host !== new URL(attempt.redirectUri).host) {
          callbackPage(res, 404, '无效的登录回调。'); return;
        }
        if (attempt.consumed || local.attempt !== attempt || url.searchParams.getAll('state').length !== 1 || !equal(url.searchParams.get('state') || '', state)) {
          callbackPage(res, 400, '登录校验未通过，请返回设置重试。'); return;
        }
        const pendingCookies = (req.headers.cookie || '').split(';').map(item => item.trim()).filter(item => item.startsWith(`${CHATGPT_PENDING_COOKIE}=`));
        const pendingCookie = pendingCookies[0]?.slice(CHATGPT_PENDING_COOKIE.length + 1) || '';
        if (pendingCookies.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(pendingCookie) ||
          !equal(createHash('sha256').update(pendingCookie).digest('hex'), browserSessionHash)) {
          callbackPage(res, 400, '请在发起登录的同一浏览器中完成授权。'); return;
        }
        attempt.consumed = true;
        const suppliedId = url.searchParams.get('client_id');
        if (url.searchParams.has('error')) throw new ChatGPTAuthError('ChatGPT 登录未获授权，请返回设置重试。', 401);
        const clientId = attempt.requestedClientId === 'dynamic_agent_client' ? suppliedId : attempt.requestedClientId;
        if (!clientIdValid(clientId) || (attempt.requestedClientId !== 'dynamic_agent_client' && suppliedId !== null && suppliedId !== clientId) ||
          url.searchParams.getAll('client_id').length > 1 || url.searchParams.getAll('code').length !== 1 || !cleanText(url.searchParams.get('code'), 8192)) {
          throw new ChatGPTAuthError('ChatGPT 注册校验未通过，请重新登录。', 401);
        }
        let value: Record<string, unknown>;
        try {
          value = await tokenGrant(new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId,
            code: url.searchParams.get('code')!, code_verifier: verifier, redirect_uri: attempt.redirectUri, resource: RESOURCE }));
        } catch (error) {
          // The registration already exists after invalid_grant; retry it rather than registering a duplicate.
          if (error instanceof ChatGPTAuthError && error.status === 401 && !attempt.registration) local.retryClientId = clientId;
          throw error;
        }
        const identity = await verifyIdentity(value.id_token, clientId, nonce);
        if (attempt.registration && identity.subject !== attempt.registration.subject) throw new ChatGPTAuthError('ChatGPT 账号与原注册不一致，请使用原账号登录。', 401);
        const credentials = credentialsFrom(value);
        const activeCookie = random();
        await locked(dir, () => {
          // A signout or superseding sign-in must not resurrect the old attempt.
          if (local.attempt !== attempt || local.stopping) throw new ChatGPTAuthError('登录已取消，请重新登录。', 409);
          const current = readSaved(dir);
          writeSaved(dir, { ...current, registration: { clientId, ...identity }, credentials, enabled: false,
            browserSessionHash: createHash('sha256').update(activeCookie).digest('hex'), browserSessionExpiresAt: Date.now() + 30 * 24 * 60 * 60_000 });
        });
        local.error = undefined;
        local.retryClientId = undefined;
        callbackPage(res, 200, credentials.scopes.includes(PLAN_SCOPE) ? 'ChatGPT 已连接。' : '已登录，但尚未授权使用 ChatGPT 套餐。', [
          `${CHATGPT_SESSION_COOKIE}=${activeCookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
          `${CHATGPT_PENDING_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
        ]);
      } catch (error) {
        local.error = error instanceof ChatGPTAuthError ? error.message : 'ChatGPT 登录未完成，请返回设置重试。';
        callbackPage(res, 400, local.error);
      } finally { if (attempt?.consumed && local.attempt === attempt) closeAttempt(local); }
    });
    server.requestTimeout = 15_000; server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', () => reject(new ChatGPTAuthError('无法启动本地登录回调，请重试。', 500)));
      server.listen(0, '127.0.0.1', () => resolve());
    });
    server.unref();
    const address = server.address();
    if (!address || typeof address === 'string') { server.close(); throw new ChatGPTAuthError('无法启动本地登录回调。', 500); }
    const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    const timeout = setTimeout(() => { if (local.attempt === attempt) { local.error = 'ChatGPT 登录已超时，请重试。'; closeAttempt(local); } }, 10 * 60_000);
    timeout.unref();
    const requestedClientId = saved.registration?.clientId || local.retryClientId || 'dynamic_agent_client';
    attempt = { state, nonce, verifier, redirectUri, registration: saved.registration, requestedClientId, server, timeout, consumed: false };
    local.attempt = attempt;
    const url = new URL(AUTHORIZE);
    url.search = new URLSearchParams({ client_id: requestedClientId, ext_agent_host_id: saved.hostId,
      ...(requestedClientId === 'dynamic_agent_client' ? { agent_name_hint: 'OpenGEO' } : {}),
      response_type: 'code', redirect_uri: redirectUri, scope: SCOPES, resource: RESOURCE, state, nonce,
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
    // Omit both login hints: starting a login must expose neither a saved identity nor a credential.
    return { authorizationUrl: url.href };
  } finally { local.starting = false; }
}

async function access(dir: string): Promise<{ accessToken: string; model: string; clientId: string; reasoningEffort?: ChatGPTReasoningEffort }> {
  if (runtime(dir).stopping) throw new ChatGPTAuthError('ChatGPT 正在退出登录。', 409);
  return locked(dir, async () => {
    if (runtime(dir).stopping) throw new ChatGPTAuthError('ChatGPT 正在退出登录。', 409);
    const saved = readSaved(dir);
    if (!saved.credentials || !saved.registration) throw new ChatGPTAuthError('请先在设置中登录 ChatGPT。', 401);
    if (saved.credentials.expiresAt < Date.now() + 60_000) {
      if (!saved.credentials.refreshToken) throw new ChatGPTAuthError('ChatGPT 授权已过期，请重新登录。', 401);
      try {
        const value = await tokenGrant(new URLSearchParams({ grant_type: 'refresh_token', client_id: saved.registration.clientId,
          refresh_token: saved.credentials.refreshToken, resource: RESOURCE }));
        if (value.id_token !== undefined) {
          const identity = await verifyIdentity(value.id_token, saved.registration.clientId);
          if (identity.subject !== saved.registration.subject) throw new ChatGPTAuthError('ChatGPT 身份验证未通过，请重新登录。', 401);
        }
        saved.credentials = credentialsFrom(value, saved.credentials);
        writeSaved(dir, saved);
      } catch (error) {
        // Authorization loss must not silently switch future audits to another paid provider.
        if (error instanceof ChatGPTAuthError && error.status === 401) { delete saved.credentials; delete saved.browserSessionHash; delete saved.browserSessionExpiresAt; writeSaved(dir, saved); }
        throw error;
      }
    }
    if (!saved.credentials.scopes.includes(PLAN_SCOPE)) throw new ChatGPTAuthError('当前登录尚未授权使用 ChatGPT 套餐，请重新授权。', 403);
    return { accessToken: saved.credentials.accessToken, model: saved.model, clientId: saved.registration.clientId,
      ...(saved.reasoningEffort ? { reasoningEffort: saved.reasoningEffort } : {}) };
  });
}

/** Server-internal only; callers must never serialize this return value or SDK errors. */
export async function getChatGPTAccess(): Promise<{ accessToken: string; model: string; reasoningEffort?: ChatGPTReasoningEffort }> {
  const value = await access(directory());
  if (!value.model) throw new ChatGPTAuthError('请先在设置中选择 ChatGPT 模型。');
  return { accessToken: value.accessToken, model: value.model, ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) };
}

async function modelCatalog(dir: string) {
  const session = await access(dir);
  const response = await request(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${session.accessToken}` } });
  if (!response.ok) throw new ChatGPTAuthError('无法读取当前 ChatGPT 账号的可用模型，请重试。', response.status === 401 ? 401 : 502);
  const value = await json(response);
  if (!Array.isArray(value.models)) throw new ChatGPTAuthError('ChatGPT 模型列表格式无效。', 502);
  const models: ChatGPTModel[] = value.models.filter(item => isObject(item) && item.visibility === 'list' && cleanText(item.slug, 200) && cleanText(item.display_name))
    .map(item => ({ id: item.slug as string, name: item.display_name as string,
      ...(Array.isArray(item.supported_reasoning_levels) ? { reasoningEfforts: [...new Set<ChatGPTReasoningEffort>((item.supported_reasoning_levels as unknown[])
        .map(level => isObject(level) ? level.effort : undefined).filter(isChatGPTReasoningEffort))] } : {}),
      ...(isChatGPTReasoningEffort(item.default_reasoning_level) ? { defaultReasoningEffort: item.default_reasoning_level } : {}),
    }));
  return { models, clientId: session.clientId };
}

export async function listChatGPTModels(): Promise<ChatGPTModel[]> { return (await modelCatalog(directory())).models; }

export async function selectChatGPTModel(model: string, reasoningEffort?: unknown): Promise<ChatGPTStatus> {
  if (!cleanText(model, 200)) throw new ChatGPTAuthError('请选择有效的 ChatGPT 模型。');
  const dir = directory();
  const catalog = await modelCatalog(dir);
  const selected = catalog.models.find(item => item.id === model);
  if (!selected) throw new ChatGPTAuthError('该模型不在当前账号的可用模型列表中。');
  if (reasoningEffort !== undefined && reasoningEffort !== 'default'
    && (!isChatGPTReasoningEffort(reasoningEffort) || !selected.reasoningEfforts?.includes(reasoningEffort))) {
    throw new ChatGPTAuthError('当前模型不支持这个思考强度，请重新选择。');
  }
  return locked(dir, () => {
    const saved = readSaved(dir);
    if (!saved.credentials || saved.registration?.clientId !== catalog.clientId || runtime(dir).stopping) throw new ChatGPTAuthError('ChatGPT 连接已改变，请刷新后重试。', 409);
    if (reasoningEffort === 'default') delete saved.reasoningEffort;
    else if (isChatGPTReasoningEffort(reasoningEffort)) saved.reasoningEffort = reasoningEffort;
    else if (saved.reasoningEffort && !selected.reasoningEfforts?.includes(saved.reasoningEffort)) delete saved.reasoningEffort;
    saved.model = model; writeSaved(dir, saved);
    return publicStatus(saved, runtime(dir));
  });
}

export async function setChatGPTAnalysisEnabled(enabled: boolean): Promise<ChatGPTStatus> {
  if (typeof enabled !== 'boolean') throw new ChatGPTAuthError('请选择有效的分析设置。');
  const dir = directory();
  return locked(dir, () => {
    const saved = readSaved(dir);
    const status = publicStatus(saved, runtime(dir));
    if (enabled && (!status.connected || !status.planEnabled || !saved.model || runtime(dir).stopping)) throw new ChatGPTAuthError('请先登录 ChatGPT、授权套餐使用并选择模型。');
    if (!saved.hostId) saved.hostId = `urn:uuid:${randomUUID()}`;
    saved.enabled = enabled; writeSaved(dir, saved);
    return publicStatus(saved, runtime(dir));
  });
}

export async function disconnectChatGPT(): Promise<{ revoked: boolean; remoteRevocationConfirmed: boolean; status: ChatGPTStatus }> {
  const dir = directory();
  const local = runtime(dir);
  local.stopping = true; closeAttempt(local);
  try {
    return await locked(dir, async () => {
      const saved = readSaved(dir);
      let confirmed = !saved.credentials;
      if (saved.credentials?.refreshToken && saved.registration) {
        try {
          const metadata = await discovery();
          const endpoint = officialEndpoint(metadata.revocation_endpoint);
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const response = await request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ token: saved.credentials.refreshToken, token_type_hint: 'refresh_token', client_id: saved.registration.clientId }).toString() });
              confirmed = response.status === 200;
              if (confirmed || response.status < 500) break;
            } catch { /* Retry a transient network failure once while credentials are available. */ }
            if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 250));
          }
        } catch { /* Local signout still completes; public status discloses unconfirmed revocation. */ }
      }
      delete saved.credentials; delete saved.browserSessionHash; delete saved.browserSessionExpiresAt; saved.enabled = false;
      if (saved.hostId) writeSaved(dir, saved);
      local.error = confirmed ? undefined : '已在本机退出；未确认远端撤销，可在 ChatGPT 设置中断开 OpenGEO。';
      return { revoked: confirmed, remoteRevocationConfirmed: confirmed, status: publicStatus(saved, local) };
    });
  } finally { local.stopping = false; }
}

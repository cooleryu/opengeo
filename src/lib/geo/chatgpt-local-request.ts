import { createHash } from 'node:crypto';

export const CHATGPT_SESSION_COOKIE = 'opengeo_chatgpt_session';
export const CHATGPT_PENDING_COOKIE = 'opengeo_chatgpt_pending';

export class ChatGPTLocalRequestError extends Error {
  constructor(message: string, public status = 403) { super(message); }
}

export function cookieHash(request: Request, name: string): string {
  const values = (request.headers.get('cookie') || '').split(';').map(value => value.trim())
    .filter(value => value.startsWith(`${name}=`));
  if (values.length !== 1) return '';
  const value = values[0].slice(name.length + 1);
  if (!/^[a-zA-Z0-9_-]{43}$/.test(value)) return '';
  return createHash('sha256').update(value).digest('hex');
}

/** Session authorization is checked separately; Host/Origin alone are not authentication. */
export function requireChatGPTLocalRequest(request: Request, mutation = false): void {
  const url = new URL(request.url);
  const host = request.headers.get('host') || url.host;
  // Next may normalize request.url to localhost. Use the literal Host authority,
  // never forwarded headers, and still require an independently authorized session.
  if (url.protocol !== 'http:' || !/^127\.0\.0\.1(?::[0-9]{1,5})?$/.test(host)) {
    throw new ChatGPTLocalRequestError('请通过本机 127.0.0.1 地址使用 ChatGPT 连接。');
  }
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  const expectedOrigin = `http://${host}`;
  if ((origin && origin !== expectedOrigin) || (site && site !== 'same-origin' && site !== 'none')) {
    throw new ChatGPTLocalRequestError('只接受当前 OpenGEO 页面发起的操作。');
  }
  if (mutation && (origin !== expectedOrigin || !request.headers.get('content-type')?.startsWith('application/json'))) {
    throw new ChatGPTLocalRequestError('请从本机 OpenGEO 页面发起操作。');
  }
}

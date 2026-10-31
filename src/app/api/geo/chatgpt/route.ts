import { randomBytes, createHash } from 'node:crypto';
import {
  ChatGPTAuthError, getChatGPTStatus, isChatGPTBrowserSession, startChatGPTSignIn,
  listChatGPTModels, selectChatGPTModel, disconnectChatGPT, setChatGPTAnalysisEnabled,
} from '@/lib/geo/chatgpt-auth';
import { requireChatGPTLocalRequest, ChatGPTLocalRequestError, cookieHash,
  CHATGPT_SESSION_COOKIE, CHATGPT_PENDING_COOKIE } from '@/lib/geo/chatgpt-local-request';
import { findChatGPTVerificationAnswer, readChatGPTVerification, verifyChatGPTAnalysis } from '@/lib/geo/chatgpt-verification';
import { resolveGeoProject } from '@/lib/geo/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
function authorized(request: Request) {
  const hash = cookieHash(request, CHATGPT_SESSION_COOKIE);
  return Boolean(hash && isChatGPTBrowserSession(hash));
}
function failure(error: unknown): Response {
  const known = error instanceof ChatGPTAuthError || error instanceof ChatGPTLocalRequestError;
  return Response.json({ error: known ? error.message : 'ChatGPT 操作未完成，请返回连接设置查看状态；未自动重试。' },
    { status: known ? error.status : 500, headers });
}

export async function GET(request: Request) {
  try {
    requireChatGPTLocalRequest(request);
    if (!authorized(request)) {
      const pending = Boolean(cookieHash(request, CHATGPT_PENDING_COOKIE));
      // No account information is exposed until this browser completes OAuth.
      const error = pending ? getChatGPTStatus().error : undefined;
      return Response.json({ connected: false, planEnabled: false, enabled: false, model: '', accountLabel: '', pending,
        ...(error ? { error } : {}) }, { headers });
    }
    const projectId = resolveGeoProject(new URL(request.url).searchParams.get('project'));
    const selected = findChatGPTVerificationAnswer(projectId);
    return Response.json({ ...getChatGPTStatus(),
      candidate: selected ? { question: selected.observation.query, collectedAt: selected.observation.recordedAt } : null,
      verification: readChatGPTVerification(),
    }, { headers });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    requireChatGPTLocalRequest(request, true);
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 2048) throw new ChatGPTLocalRequestError('请求内容过长。', 400);
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ChatGPTLocalRequestError('请求格式无效。', 400);
    if (Object.keys(body).some(key => !['action', 'model', 'reasoningEffort', 'enabled', 'projectId', 'requestId', 'acknowledgeUsage'].includes(key))) {
      throw new ChatGPTLocalRequestError('请求包含不支持的字段。', 400);
    }
    if (body.action === 'signin') {
      const pendingCookie = randomBytes(32).toString('base64url');
      const result = await startChatGPTSignIn(createHash('sha256').update(pendingCookie).digest('hex'));
      return Response.json(result, { headers: { ...headers,
        'Set-Cookie': `${CHATGPT_PENDING_COOKIE}=${pendingCookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`,
      } });
    }
    if (!authorized(request)) throw new ChatGPTLocalRequestError('请先在当前浏览器完成 ChatGPT 登录授权。', 401);
    if (body.action === 'models') return Response.json({ models: await listChatGPTModels() }, { headers });
    if (body.action === 'auto-analysis' && typeof body.enabled === 'boolean') {
      return Response.json(await setChatGPTAnalysisEnabled(body.enabled), { headers });
    }
    if (body.action === 'model' && typeof body.model === 'string') {
      return Response.json(await selectChatGPTModel(body.model, body.reasoningEffort), { headers });
    }
    if (body.action === 'disconnect') {
      const result = await disconnectChatGPT();
      return Response.json(result, { headers: { ...headers,
        'Set-Cookie': `${CHATGPT_SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      } });
    }
    if (body.action === 'analyze' && body.acknowledgeUsage === true
      && typeof body.requestId === 'string' && /^[0-9a-f-]{36}$/i.test(body.requestId)) {
      const status = getChatGPTStatus();
      if (!status.planEnabled || !status.model) throw new ChatGPTLocalRequestError('请先授权订阅额度并选择模型。', 409);
      return Response.json(await verifyChatGPTAnalysis(resolveGeoProject(body.projectId), body.requestId), { headers });
    }
    throw new ChatGPTLocalRequestError('请选择有效操作；真实分析需要明确确认使用订阅额度。', 400);
  } catch (error) { return failure(error); }
}

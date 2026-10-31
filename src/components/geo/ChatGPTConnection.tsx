'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ExternalLink,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { SiOpenai } from '@icons-pack/react-simple-icons';
import GeoSelect from './GeoSelect';
import type { ChatGPTStatus, ChatGPTModel } from '@/lib/geo/chatgpt-types';
import { CHATGPT_REASONING_LABELS } from '@/lib/geo/chatgpt-types';
import type { ChatGPTVerification } from '@/lib/geo/chatgpt-verification';

type Status = ChatGPTStatus & {
  candidate?: { question: string; collectedAt: string } | null;
  verification?: ChatGPTVerification | null;
};
const verdict = (value: string) =>
  value === 'yes' ? '是' : value === 'no' ? '否' : '待核实';

export default function ChatGPTConnection({
  projectId,
  onSaved,
}: {
  projectId: string;
  onSaved: () => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [models, setModels] = useState<ChatGPTModel[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [verification, setVerification] = useState<ChatGPTVerification | null>(
    null,
  );
  const polling = useRef(false);
  const refresh = useCallback(async () => {
    const response = await fetch(
      `/api/geo/chatgpt?project=${encodeURIComponent(projectId)}`,
      { cache: 'no-store' },
    );
    const next = await response.json();
    if (!response.ok) throw new Error(next.error || '无法读取 ChatGPT 连接。');
    setStatus(next);
    if (next.verification?.projectId === projectId)
      setVerification(next.verification);
    return next as Status;
  }, [projectId]);
  const send = async (body: Record<string, unknown>) => {
    const response = await fetch('/api/geo/chatgpt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '操作未完成。');
    return result;
  };

  useEffect(() => {
    let live = true;
    const load = () => {
      if (!polling.current) {
        polling.current = true;
        void refresh()
          .catch((reason) => {
            if (live) setError(reason.message);
          })
          .finally(() => {
            polling.current = false;
          });
      }
    };
    load();
    window.addEventListener('focus', load);
    return () => {
      live = false;
      window.removeEventListener('focus', load);
    };
  }, [refresh]);

  useEffect(() => {
    if (!status?.pending || status.connected) return;
    const timer = setInterval(() => {
      void refresh().catch(() => {});
    }, 2500);
    return () => clearInterval(timer);
  }, [status?.pending, status?.connected, refresh]);

  useEffect(() => {
    if (!status?.connected || !status.planEnabled) {
      setModels([]);
      return;
    }
    let live = true;
    void send({ action: 'models' })
      .then((result) => {
        if (live) setModels(result.models);
      })
      .catch((reason) => {
        if (live) setError(reason.message);
      });
    return () => {
      live = false;
    };
  }, [status?.connected, status?.planEnabled]);

  async function signIn() {
    setBusy('signin');
    setError('');
    setMessage('');
    const popup = window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    try {
      const result = await send({ action: 'signin' });
      const url = new URL(result.authorizationUrl);
      if (
        url.origin !== 'https://auth.openai.com' ||
        url.pathname !== '/api/accounts/authorize'
      )
        throw new Error('授权地址无效。');
      if (popup) popup.location.href = url.href;
      else window.location.assign(url.href);
      setStatus((previous) =>
        previous ? { ...previous, pending: true } : previous,
      );
      setMessage('请在 OpenAI 页面完成登录和授权，然后回到这里。');
    } catch (reason) {
      popup?.close();
      setError(reason instanceof Error ? reason.message : '无法开始登录。');
    } finally {
      setBusy('');
    }
  }

  async function selectModel(model: string, reasoningEffort?: string) {
    setBusy('model');
    setError('');
    try {
      await send({
        action: 'model',
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '模型选择未保存。');
    } finally {
      setBusy('');
    }
  }

  async function setAutomaticAnalysis(enabled: boolean) {
    setBusy('auto-analysis');
    setError('');
    try {
      await send({ action: 'auto-analysis', enabled });
      await refresh();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : '自动分析设置未保存。',
      );
    } finally {
      setBusy('');
    }
  }

  async function analyze() {
    setBusy('analyze');
    setError('');
    setMessage('');
    try {
      const result = await send({
        action: 'analyze',
        projectId,
        requestId: crypto.randomUUID(),
        acknowledgeUsage: true,
      });
      setVerification(result);
      if (result.state === 'complete') onSaved();
      else setError(result.error || '本次分析尚未完成。');
      await refresh();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : '分析未完成；未自动重试。',
      );
    } finally {
      setBusy('');
    }
  }

  async function disconnect() {
    setBusy('disconnect');
    setError('');
    try {
      const result = await send({ action: 'disconnect' });
      setMessage(
        result.remoteRevocationConfirmed
          ? '已退出并撤销本次授权会话。'
          : '已清除本地凭证；远端撤销未确认，请到 ChatGPT 中管理授权。',
      );
      setVerification(null);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '退出未完成。');
    } finally {
      setBusy('');
    }
  }

  const selectedModel = models.find((model) => model.id === status?.model);

  return (
    <section
      className="cs-model-card cs-chatgpt"
      aria-labelledby="cs-chatgpt-title"
    >
      <header className="cs-section-heading">
        <div>
          <h3 id="cs-chatgpt-title">
            <SiOpenai size={18} /> ChatGPT 订阅
          </h3>
          <p>
            {status?.enabled
              ? '搜索后使用订阅额度，分析品牌提及与自有内容引用。'
              : '使用订阅额度，按需分析已有回答。'}
          </p>
        </div>
        <span
          className={`cs-status ${status?.planEnabled ? 'cs-configured' : ''}`}
        >
          {status?.planEnabled
            ? '订阅已授权'
            : status?.connected
              ? '未授权订阅'
              : '未连接'}
        </span>
      </header>
      {!status?.connected ? (
        <>
          <button
            type="button"
            className="cs-button cs-primary cs-chatgpt-login"
            onClick={() => void signIn()}
            disabled={!!busy}
          >
            {busy === 'signin' ? (
              <Loader2 size={17} className="spin" />
            ) : (
              <SiOpenai size={17} />
            )}{' '}
            Continue with ChatGPT
          </button>
          <p className="cs-hint">
            <ShieldCheck size={14} /> 凭证仅保存在本机，不随开源代码分发。
          </p>
        </>
      ) : (
        <>
          <div className="cs-chatgpt-account">
            <Check size={16} />
            <span>{status.accountLabel || '已连接 ChatGPT 账号'}</span>
            <a
              className="cs-link"
              href="https://chatgpt.com/#settings/Usage"
              target="_blank"
              rel="noreferrer"
            >
              管理使用量 <ExternalLink size={12} />
            </a>
            <button
              className="cs-link"
              onClick={() => void disconnect()}
              disabled={!!busy}
            >
              退出连接
            </button>
          </div>
          {status.planEnabled ? (
            <>
              <div className="cs-chatgpt-controls">
                <label className="cs-chatgpt-model">
                  分析模型
                  <GeoSelect
                    label="ChatGPT 分析模型"
                    value={status.model}
                    onChange={(model) => void selectModel(model)}
                    disabled={!!busy || !models.length}
                    options={[
                      ...(!status.model
                        ? [
                            {
                              value: '',
                              label: models.length
                                ? '选择模型'
                                : '正在读取可用模型…',
                              disabled: true,
                            },
                          ]
                        : []),
                      ...models.map((model) => ({
                        value: model.id,
                        label: model.name,
                      })),
                    ]}
                  />
                </label>
                <label className="cs-chatgpt-model">
                  思考强度
                  <GeoSelect
                    label="ChatGPT 思考强度"
                    value={status.reasoningEffort || 'default'}
                    onChange={(effort) =>
                      void selectModel(status.model, effort)
                    }
                    disabled={
                      !!busy || !selectedModel?.reasoningEfforts?.length
                    }
                    options={[
                      {
                        value: 'default',
                        label: selectedModel?.defaultReasoningEffort
                          ? `默认（${CHATGPT_REASONING_LABELS[selectedModel.defaultReasoningEffort]}）`
                          : '模型默认',
                      },
                      ...(selectedModel?.reasoningEfforts || []).map(
                        (effort) => ({
                          value: effort,
                          label: CHATGPT_REASONING_LABELS[effort],
                        }),
                      ),
                    ]}
                  />
                </label>
              </div>
              <p className="cs-hint">思考强度越高，通常耗时和用量也越高。</p>
              <label className="cs-auto-analysis">
                搜索后自动分析
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="使用 ChatGPT 订阅进行搜索后自动分析"
                  checked={status.enabled}
                  disabled={!!busy || !status.model}
                  onChange={(event) =>
                    void setAutomaticAnalysis(event.target.checked)
                  }
                />
              </label>
              <details className="cs-verification">
                <summary>
                  测试分析
                  {verification?.state === 'complete' && (
                    <span>
                      <Check size={13} /> 上次已通过
                    </span>
                  )}
                  <ChevronDown size={14} className="cs-disclosure-chevron" />
                </summary>
                {status.candidate ? (
                  <div className="cs-chatgpt-proof">
                    <span className="cs-hint">验证用的已有回答</span>
                    <p>{status.candidate.question}</p>
                    <div className="cs-actions">
                      <button
                        className="cs-button cs-primary"
                        onClick={() => void analyze()}
                        disabled={!!busy || !status.model}
                      >
                        {busy === 'analyze' && (
                          <Loader2 size={15} className="spin" />
                        )}
                        {busy === 'analyze'
                          ? '正在分析…'
                          : '使用订阅分析这条回答'}
                      </button>
                      <span className="cs-hint">
                        消耗本账号额度 · 仅 1 条 · 不重新搜索
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className="cs-hint">
                    当前项目没有证据完整的已保存回答可用于验证。
                  </p>
                )}
                {verification?.state === 'complete' && (
                  <div className="cs-chatgpt-result" role="status">
                    <strong>
                      <Check size={15} /> 真实分析完成并已保存
                    </strong>
                    <p>
                      {verification.inference?.model}
                      {verification.inference?.reasoningEffort
                        ? ` · ${CHATGPT_REASONING_LABELS[verification.inference.reasoningEffort]}`
                        : ''}{' '}
                      · 品牌提及：
                      {verdict(verification.audit?.mention || 'unknown')} ·
                      自有引用：
                      {verdict(verification.audit?.citation || 'unknown')}
                    </p>
                    <p className="cs-hint">
                      {verification.inference?.usage
                        ? `输入 ${verification.inference.usage.inputTokens} / 输出 ${verification.inference.usage.outputTokens} tokens · `
                        : ''}
                      使用 ChatGPT 订阅授权，未调用 DeepSeek。
                    </p>
                    <details>
                      <summary>查看判断依据</summary>
                      <p>{verification.audit?.mentionEvidence}</p>
                      <p>{verification.audit?.citationEvidence}</p>
                    </details>
                  </div>
                )}
              </details>
            </>
          ) : (
            <p className="cs-hint">
              登录成功，但尚未获得订阅使用权限。请重新登录并在 OpenAI 页面授权。
            </p>
          )}
          {!status.planEnabled && (
            <button
              className="cs-button"
              onClick={() => void signIn()}
              disabled={!!busy}
            >
              重新授权
            </button>
          )}
        </>
      )}
      {(error || status?.error) && (
        <p className="cs-feedback cs-error" role="alert">
          {error || status?.error}
        </p>
      )}
      {message && !status?.connected && (
        <p className="cs-feedback" role="status">
          {message}
        </p>
      )}
    </section>
  );
}

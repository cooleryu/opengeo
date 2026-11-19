'use client';

import { useEffect, useState } from 'react';
import {
  Activity,
  ArrowRight,
  BrainCircuit,
  Check,
  ChevronDown,
  FileText,
  Loader2,
  RefreshCw,
  Search,
} from 'lucide-react';
import type {
  GeoConnectionSettings,
  GeoSettingsSection,
} from '@/lib/geo/connection-settings-types';
import type { ResearchBatch, ResearchEngine } from '@/lib/geo/research-types';
import type { TrafficSnapshot } from '@/lib/geo/traffic-types';
import GeoSelect from './GeoSelect';
import ChatGPTConnection from './ChatGPTConnection';
import { useUiLanguage } from './UiLanguageContext';
import './connection-settings.css';

type Props = {
  projectId: string;
  research: ResearchBatch | null | undefined;
  onSaved: () => void;
  onRecords: (engine: ResearchEngine) => void;
  onOpenTraffic?: () => void;
};
type ProjectContextPayload = {
  projectId: string;
  path: string;
  source: 'file' | 'synthesized';
  markdown: string;
  synthesizedMarkdown?: string;
};
type ModelDraft = {
  provider: 'gemini' | 'deepseek' | 'openai' | 'custom';
  model: string;
  baseURL: string;
  apiKey: string;
};
type Feedback = { error?: string; message?: string };
const modelDraft = (model: GeoConnectionSettings['model']): ModelDraft => ({
  provider: model.provider,
  model: model.model,
  baseURL: model.baseURL,
  apiKey: '',
});
const presets = {
  gemini: {
    model: 'gemini-3.8-flash',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  deepseek: { model: 'deepseek-flash', baseURL: 'https://api.deepseek.com' },
  openai: { model: '', baseURL: 'https://api.openai.com/v1' },
};
const platforms: {
  id: ResearchEngine;
  name: string;
  kindZh: string;
  kindEn: string;
}[] = [
  { id: 'chatgpt', name: 'ChatGPT', kindZh: '网页回答', kindEn: 'Web answers' },
  { id: 'google', name: 'Google', kindZh: '网页搜索', kindEn: 'Web search' },
];

export default function ConnectionSettingsPanel({
  projectId,
  research,
  onSaved,
  onRecords,
  onOpenTraffic,
}: Props) {
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const [settings, setSettings] = useState<GeoConnectionSettings | null>(null);
  const [model, setModel] = useState<ModelDraft>({
    provider: 'custom',
    model: '',
    baseURL: '',
    apiKey: '',
  });
  const [modelDirty, setModelDirty] = useState(false);
  const [busy, setBusy] = useState('');
  const [loadError, setLoadError] = useState('');
  const [feedback, setFeedback] = useState<
    Partial<Record<GeoSettingsSection, Feedback>>
  >({});
  const [testConfirmation, setTestConfirmation] =
    useState<GeoSettingsSection | null>(null);
  const [contextData, setContextData] = useState<ProjectContextPayload | null>(null);
  const [contextDraft, setContextDraft] = useState('');
  const [contextDirty, setContextDirty] = useState(false);
  const [contextBusy, setContextBusy] = useState(false);
  const [contextFeedback, setContextFeedback] = useState<Feedback>({});
  const [trafficSnapshot, setTrafficSnapshot] = useState<TrafficSnapshot | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/geo/settings', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || '读取设置失败。');
        return body as GeoConnectionSettings;
      })
      .then((next) => {
        setSettings(next);
        setModel(modelDraft(next.model));
      })
      .catch((error) => {
        if (!controller.signal.aborted) setLoadError(error.message);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    setContextFeedback({});
    setContextDirty(false);
    fetch(
      `/api/geo/project-context?project=${encodeURIComponent(projectId)}`,
      { cache: 'no-store', signal: controller.signal },
    )
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || '读取项目事实档案失败。');
        return body as ProjectContextPayload;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setContextData(payload);
        setContextDraft(payload.markdown);
      })
      .catch(() => {
        if (!controller.signal.aborted) setContextData(null);
      });

    fetch(
      `/api/geo/traffic?project=${encodeURIComponent(projectId)}`,
      { cache: 'no-store', signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as TrafficSnapshot;
      })
      .then((snap) => {
        if (!controller.signal.aborted) setTrafficSnapshot(snap);
      })
      .catch(() => {
        if (!controller.signal.aborted) setTrafficSnapshot(null);
      });

    return () => controller.abort();
  }, [projectId]);

  const saveProjectContext = async () => {
    if (!contextDraft.trim() || contextBusy) return;
    setContextBusy(true);
    setContextFeedback({});
    try {
      const response = await fetch('/api/geo/project-context', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: projectId, markdown: contextDraft }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '保存项目事实档案失败。');
      setContextData((prev) => ({
        projectId,
        path: body.path,
        source: body.source,
        markdown: body.markdown,
        synthesizedMarkdown: prev?.synthesizedMarkdown,
      }));
      setContextDraft(body.markdown);
      setContextDirty(false);
      setContextFeedback({
        message: isEn
          ? 'Saved to project-context.md. Future planning, writing, and review runs will use it.'
          : '已保存到 project-context.md，后续的问题规划、改稿与审核将自动读取这份档案。',
      });
    } catch (error) {
      setContextFeedback({
        error:
          error instanceof Error
            ? error.message
            : isEn
              ? 'Failed to save project-context.md.'
              : '保存失败，请重试。',
      });
    } finally {
      setContextBusy(false);
    }
  };

  const report = (section: GeoSettingsSection, result: Feedback) =>
    setFeedback((previous) => ({ ...previous, [section]: result }));

  async function save(
    section: GeoSettingsSection,
    values: Record<string, string>,
  ) {
    setBusy(`save:${section}`);
    report(section, {});
    try {
      const response = await fetch('/api/geo/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section, values }),
      });
      const next = await response.json();
      if (!response.ok) throw new Error(next.error || '保存失败，请重试。');
      setSettings(next);
      setModel(modelDraft(next.model));
      setModelDirty(false);
      setTestConfirmation(null);
      report(section, {
        message: '已保存，新发起的 AI 操作使用此配置。',
      });
      onSaved();
    } catch (error) {
      report(section, {
        error: error instanceof Error ? error.message : '保存失败。',
      });
    } finally {
      setBusy('');
    }
  }

  async function testConnection(section: GeoSettingsSection) {
    setBusy(`test:${section}`);
    setTestConfirmation(null);
    report(section, {});
    try {
      const response = await fetch('/api/geo/settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section, acknowledgeCost: true }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok)
        throw new Error(result.error || result.message || '测试未通过。');
      report(section, { message: result.message });
    } catch (error) {
      report(section, {
        error: error instanceof Error ? error.message : '测试失败。',
      });
    } finally {
      setBusy('');
    }
  }

  function result(section: GeoSettingsSection) {
    const state = feedback[section];
    return state?.error || state?.message ? (
      <p
        className={`cs-feedback ${state.error ? 'cs-error' : ''}`}
        role={state.error ? 'alert' : 'status'}
      >
        {!state.error && <Check size={14} />}
        {state.error || state.message}
      </p>
    ) : null;
  }

  function confirmation(section: GeoSettingsSection) {
    return testConfirmation === section ? (
      <div
        className="cs-confirm"
        role="group"
        aria-label={isEn ? 'Confirm connection test' : '确认测试连接'}
      >
        <span>
          {isEn
            ? 'Send one test request using the saved configuration (may incur API usage cost).'
            : '使用已保存配置发送一次测试请求，可能产生对应接口费用。'}
        </span>
        <button
          type="button"
          className="cs-button"
          onClick={() => testConnection(section)}
          disabled={!!busy}
        >
          {isEn ? 'Confirm test' : '确认测试'}
        </button>
        <button
          type="button"
          className="cs-link"
          onClick={() => setTestConfirmation(null)}
        >
          {isEn ? 'Cancel' : '取消'}
        </button>
      </div>
    ) : null;
  }

  if (loadError)
    return (
      <div className="cs-feedback cs-error" role="alert">
        {loadError}
      </div>
    );
  if (!settings)
    return (
      <div className="cs-loading">
        <Loader2 size={18} className="spin" />
        {isEn ? 'Loading settings…' : '正在读取设置…'}
      </div>
    );
  const observations =
    research?.questions.flatMap((question) => question.observations) ?? [];
  const changedDestination =
    model.provider !== settings.model.provider ||
    model.baseURL.replace(/\/$/, '') !==
      settings.model.baseURL.replace(/\/$/, '');

  return (
    <div className="cs-page">
      <p className="cs-scope">
        {isEn
          ? 'Connection settings apply across all projects.'
          : '连接设置适用于所有项目。'}
      </p>
      <section className="cs-group" aria-labelledby="cs-analysis-title">
        <header className="cs-group-heading">
          <span className="cs-group-icon">
            <BrainCircuit size={21} />
          </span>
          <div>
            <h2 id="cs-analysis-title">
              {isEn ? 'Analysis Agent' : '分析 Agent'}
            </h2>
            <p>
              {isEn
                ? 'Configure the LLM used for repo understanding, answer audits, and draft writing.'
                : '配置用于理解、分析与审核的模型。'}
            </p>
          </div>
        </header>
        <div className="cs-model-grid">
          <section className="cs-model-card" aria-labelledby="cs-model-title">
            <header className="cs-section-heading">
              <div>
                <h3 id="cs-model-title">API 模型</h3>
                <p>用于问题生成、分析、改稿与独立审核。</p>
              </div>
              <span
                className={`cs-status ${settings.model.configured ? 'cs-configured' : ''}`}
              >
                {settings.model.configured ? '已配置' : '未配置'}
              </span>
            </header>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save('model', model);
              }}
            >
              <div className="cs-fields">
                <label>
                  服务商
                  <GeoSelect<ModelDraft['provider']>
                    label="模型服务商"
                    value={model.provider}
                    disabled={!!busy}
                    onChange={(provider) => {
                      setModel((previous) => ({
                        ...previous,
                        provider,
                        ...(provider === 'custom' ? {} : presets[provider]),
                        apiKey: '',
                      }));
                      setModelDirty(true);
                      setTestConfirmation(null);
                      report('model', {});
                    }}
                    options={[
                      { value: 'gemini', label: 'Google Gemini' },
                      { value: 'deepseek', label: 'DeepSeek' },
                      { value: 'openai', label: 'OpenAI / GPT' },
                      { value: 'custom', label: '其他兼容接口' },
                    ]}
                  />
                </label>
                <label>
                  模型
                  <input
                    value={model.model}
                    required
                    autoComplete="off"
                    placeholder="填写模型名称"
                    onChange={(event) => {
                      setModel({ ...model, model: event.target.value });
                      setModelDirty(true);
                      report('model', {});
                    }}
                  />
                </label>
                <label>
                  API Key
                  <input
                    type="password"
                    value={model.apiKey}
                    autoComplete="new-password"
                    spellCheck={false}
                    required={
                      !settings.model.keyConfigured || changedDestination
                    }
                    placeholder={
                      settings.model.keyConfigured && !changedDestination
                        ? '已设置，留空保留'
                        : '填写 API Key'
                    }
                    onChange={(event) => {
                      setModel({ ...model, apiKey: event.target.value });
                      setModelDirty(true);
                      report('model', {});
                    }}
                  />
                </label>
              </div>
              <details
                className="cs-advanced"
                open={model.provider === 'custom' || undefined}
              >
                <summary>接口地址</summary>
                <label>
                  API 地址
                  <input
                    type="url"
                    required
                    value={model.baseURL}
                    autoComplete="off"
                    onChange={(event) => {
                      setModel({ ...model, baseURL: event.target.value });
                      setModelDirty(true);
                      report('model', {});
                    }}
                  />
                </label>
              </details>
              {changedDestination && settings.model.keyConfigured && (
                <p className="cs-hint">
                  更换服务商或地址时，请填写对应的新 API Key。
                </p>
              )}
              <div className="cs-actions">
                <button
                  className="cs-button cs-primary"
                  type="submit"
                  disabled={!!busy || !modelDirty}
                >
                  {busy === 'save:model' && (
                    <Loader2 size={14} className="spin" />
                  )}
                  保存
                </button>
                <button
                  className="cs-button"
                  type="button"
                  disabled={!!busy || !settings.model.configured || modelDirty}
                  onClick={() => setTestConfirmation('model')}
                >
                  {busy === 'test:model' && (
                    <Loader2 size={14} className="spin" />
                  )}
                  测试连接
                </button>
                {modelDirty && <span className="cs-hint">有未保存的修改</span>}
              </div>
              {confirmation('model')}
              {result('model')}
            </form>
          </section>
          <details className="cs-web-records">
            <summary>
              暂存：ChatGPT 账号套餐登录分析（默认使用上方 API 模型）
              <ChevronDown size={14} className="cs-disclosure-chevron" />
            </summary>
            <ChatGPTConnection
              projectId={projectId}
              onSaved={onSaved}
            />
          </details>
        </div>
      </section>

      <section className="cs-group" aria-labelledby="cs-search-title">
        <header className="cs-group-heading">
          <span className="cs-group-icon cs-search-icon">
            <Search size={21} />
          </span>
          <div>
            <h2 id="cs-search-title">
              {isEn ? 'Search platforms' : '搜索平台'}
            </h2>
            <p>
              {isEn
                ? 'Focused on real ChatGPT and Google AI Overviews answers with source citations.'
                : '当前聚焦 ChatGPT 与 Google 真实回答及引用采集。'}
            </p>
          </div>
        </header>
        <div className="cs-web-record-list">
          {platforms.map((platform) => {
              const count = observations.filter(
                (observation) => observation.engine === platform.id,
              ).length;
              return (
                <div className="cs-web-record" key={platform.id}>
                  <div>
                    <strong>{platform.name}</strong>
                    <span>
                      {isEn
                        ? `${platform.kindEn} · Local browser capture`
                        : `${platform.kindZh} · 浏览器真实采集`}
                    </span>
                  </div>
                  {count ? (
                    <button
                      type="button"
                      className="cs-link"
                      onClick={() => onRecords(platform.id)}
                    >
                      {isEn ? `${count} records` : `${count} 条记录`}
                    </button>
                  ) : (
                    <span className="cs-muted">
                      {isEn ? 'None yet' : '本批暂无'}
                    </span>
                  )}
                </div>
              );
            })}
        </div>
      </section>

      <section className="cs-group" aria-labelledby="cs-context-title">
        <header className="cs-group-heading">
          <span className="cs-group-icon cs-context-icon">
            <FileText size={21} />
          </span>
          <div>
            <h2 id="cs-context-title">
              {isEn ? 'Project fact sheet (project-context.md)' : '项目事实档案（project-context.md）'}
            </h2>
            <p>
              {isEn
                ? 'Open Markdown facts shared across question planning, optimization drafts, and reviewer checks. Edit anytime.'
                : '问题规划、方案撰写与把关审核共同读取的开放 Markdown 档案，随时可微调产品定位、受众与同名排除。'}
            </p>
          </div>
        </header>

        <div className="cs-model-card cs-context-card">
          <div className="cs-context-meta">
            <span className={`cs-status${contextData?.source === 'file' ? ' is-saved' : ''}`}>
              {contextData?.source === 'file'
                ? isEn
                  ? 'Saved on disk'
                  : '已保存为项目文件'
                : isEn
                  ? 'Auto-synthesized preview (not written yet)'
                  : '自动合成预览（保存后落盘）'}
            </span>
            {contextData?.synthesizedMarkdown && (
              <button
                type="button"
                className="cs-link"
                onClick={() => {
                  setContextDraft(contextData.synthesizedMarkdown ?? '');
                  setContextDirty(true);
                  setContextFeedback({});
                }}
              >
                <RefreshCw size={12} />
                {isEn ? 'Refresh from latest project data' : '按最新采集重新生成草稿'}
              </button>
            )}
          </div>

          <textarea
            className="cs-context-editor"
            rows={11}
            value={contextDraft}
            aria-label={isEn ? 'Project context Markdown' : '项目事实档案 Markdown'}
            placeholder={
              isEn
                ? 'Loading project-context.md…'
                : '正在读取项目事实档案…'
            }
            onChange={(event) => {
              setContextDraft(event.target.value);
              setContextDirty(true);
              setContextFeedback({});
            }}
          />

          <div className="cs-actions">
            <button
              type="button"
              className="cs-button cs-primary"
              disabled={contextBusy || !contextDraft.trim() || (!contextDirty && contextData?.source === 'file')}
              onClick={() => void saveProjectContext()}
            >
              {contextBusy && <Loader2 size={14} className="spin" />}
              {isEn ? 'Save project-context.md' : '保存项目档案'}
            </button>
            {contextDirty && (
              <span className="cs-hint">
                {isEn ? 'Unsaved changes' : '有未保存的修改'}
              </span>
            )}
          </div>
          {contextFeedback.error && (
            <p className="cs-feedback is-error" role="alert">
              {contextFeedback.error}
            </p>
          )}
          {contextFeedback.message && (
            <p className="cs-feedback is-ok" role="status">
              <Check size={14} /> {contextFeedback.message}
            </p>
          )}
        </div>
      </section>

      <section id="traffic" className="cs-group" aria-labelledby="cs-traffic-title">
        <header className="cs-group-heading">
          <span className="cs-group-icon cs-traffic-icon">
            <Activity size={21} />
          </span>
          <div>
            <h2 id="cs-traffic-title">
              {isEn ? 'Website traffic & AI referrals (Optional)' : '网站流量与 AI 引流统计（可选集成）'}
            </h2>
            <p>
              {isEn
                ? 'Connect Umami when you are ready to track real visits and conversions coming from AI answers.'
                : '默认不占主导航空壳；当你准备追踪来自 ChatGPT、Google AI 的真实网站访问与转化时，可随时接入 Umami。'}
            </p>
          </div>
        </header>

        <div className="cs-traffic-opt-card">
          {trafficSnapshot &&
          (trafficSnapshot.status === 'ready' || trafficSnapshot.status === 'empty') ? (
            <div className="cs-traffic-row">
              <div>
                <div className="cs-traffic-title-line">
                  <strong>
                    {isEn ? 'Analytics connected' : '网站统计已接通'}
                  </strong>
                  <span className="cs-status is-saved">
                    {trafficSnapshot.provider ?? 'Umami'}
                  </span>
                </div>
                <p>
                  {isEn
                    ? 'Live website visitor and AI referral metrics are active for this project.'
                    : '当前项目已接入访问统计，可直接查看真实 AI 引流与页面表现。'}
                </p>
              </div>
              {onOpenTraffic && (
                <button
                  type="button"
                  className="cs-button cs-primary"
                  onClick={onOpenTraffic}
                >
                  {isEn ? 'Open traffic report' : '查看流量与引流数据'}
                  <ArrowRight size={14} />
                </button>
              )}
            </div>
          ) : (
            <div className="cs-traffic-row">
              <div>
                <div className="cs-traffic-title-line">
                  <strong>
                    {isEn ? 'Connect Umami analytics when ready' : '按需接入 Umami 网站统计'}
                  </strong>
                  <span className="cs-status">
                    {isEn ? 'Optional · Not connected' : '可选 · 暂未接入'}
                  </span>
                </div>
                <p>
                  {isEn
                    ? 'Once you add Umami tracking to your site and configure its website ID and token in local settings, OpenGEO automatically breaks out AI search referrals and landing pages.'
                    : '在你的站点加上 Umami 统计埋点并在本地配置站点 ID 与 Token 后，即可自动拆解来自 AI 搜索的真实访问与落地页；接入前不会在主导航留空页。'}
                </p>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

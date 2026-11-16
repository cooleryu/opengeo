'use client';

import { useEffect, useState } from 'react';
import {
  BrainCircuit,
  Check,
  ChevronDown,
  Loader2,
  Search,
} from 'lucide-react';
import type {
  GeoConnectionSettings,
  GeoSettingsSection,
} from '@/lib/geo/connection-settings-types';
import type { ResearchBatch, ResearchEngine } from '@/lib/geo/research-types';
import GeoSelect from './GeoSelect';
import ChatGPTConnection from './ChatGPTConnection';
import { useUiLanguage } from './UiLanguageContext';
import './connection-settings.css';

type Props = {
  projectId: string;
  research: ResearchBatch | null | undefined;
  onSaved: () => void;
  onRecords: (engine: ResearchEngine) => void;
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
              {settings.model.source === 'vane' && (
                <p className="cs-hint">
                  正在沿用已有模型连接。切换到直连时请填写 API Key。
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
    </div>
  );
}

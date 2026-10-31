'use client';

import { Fragment, useEffect, useState } from 'react';
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
import './connection-settings.css';

type Props = {
  research: ResearchBatch | null | undefined;
  onSaved: () => void;
  onRecords: (engine: ResearchEngine) => void;
};
type ModelDraft = {
  provider: 'deepseek' | 'openai' | 'custom';
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
  deepseek: { model: 'deepseek-chat', baseURL: 'https://api.deepseek.com' },
  openai: { model: '', baseURL: 'https://api.openai.com/v1' },
};
const platforms: { id: ResearchEngine; name: string; kind: string }[] = [
  { id: 'deepseek', name: 'DeepSeek', kind: '搜索 API' },
  { id: 'qwen', name: '千问', kind: '联网回答 API' },
  { id: 'doubao', name: '豆包', kind: '联网回答 API' },
  { id: 'chatgpt', name: 'ChatGPT', kind: '网页回答' },
  { id: 'google', name: 'Google', kind: '网页搜索' },
];

export default function ConnectionSettingsPanel({
  research,
  onSaved,
  onRecords,
}: Props) {
  const [settings, setSettings] = useState<GeoConnectionSettings | null>(null);
  const [model, setModel] = useState<ModelDraft>({
    provider: 'custom',
    model: '',
    baseURL: '',
    apiKey: '',
  });
  const [modelDirty, setModelDirty] = useState(false);
  const [editing, setEditing] = useState<GeoSettingsSection | null>(null);
  const [searchDraft, setSearchDraft] = useState({ apiKey: '', model: '' });
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
      if (section === 'model') {
        setModel(modelDraft(next.model));
        setModelDirty(false);
      } else {
        setEditing(null);
        setSearchDraft({ apiKey: '', model: '' });
      }
      setTestConfirmation(null);
      report(section, {
        message:
          section === 'model'
            ? '已保存，新发起的 AI 操作使用此配置。'
            : '已保存。新搜索使用此配置，已有跟测保留原模型。',
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
      <div className="cs-confirm" role="group" aria-label="确认测试连接">
        <span>
          使用已保存配置发送一次测试请求，可能产生
          {section === 'deepseek' ? ' ¥0.005 ' : ''}费用。
        </span>
        <button
          type="button"
          className="cs-button"
          onClick={() => testConnection(section)}
          disabled={!!busy}
        >
          确认测试
        </button>
        <button
          type="button"
          className="cs-link"
          onClick={() => setTestConfirmation(null)}
        >
          取消
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
        正在读取设置…
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
      <p className="cs-scope">连接设置适用于所有项目。</p>
      <section className="cs-group" aria-labelledby="cs-analysis-title">
        <header className="cs-group-heading">
          <span className="cs-group-icon">
            <BrainCircuit size={21} />
          </span>
          <div>
            <h2 id="cs-analysis-title">分析 Agent</h2>
            <p>配置用于理解、分析与审核的模型。</p>
          </div>
        </header>
        <div className="cs-model-grid">
          <ChatGPTConnection
            projectId={research?.projectId || 'example-project'}
            onSaved={onSaved}
          />
          <section className="cs-model-card" aria-labelledby="cs-model-title">
            <header className="cs-section-heading">
              <div>
                <h3 id="cs-model-title">API 模型</h3>
                <p>用于拟题、诊断、改稿与方案审核。</p>
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
        </div>
      </section>

      <section className="cs-group" aria-labelledby="cs-search-title">
        <header className="cs-group-heading">
          <span className="cs-group-icon cs-search-icon">
            <Search size={21} />
          </span>
          <div>
            <h2 id="cs-search-title">搜索 API</h2>
            <p>连接实际搜索问题、获取回答与来源的平台。</p>
          </div>
        </header>
        <div className="cs-table-wrap">
          <table className="cs-table">
            <thead>
              <tr>
                <th>平台</th>
                <th>入口</th>
                <th>连接状态</th>
                <th>本批记录</th>
                <th>
                  <span className="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {platforms
                .filter((platform) =>
                  settings.search.some((entry) => entry.id === platform.id),
                )
                .map((platform) => {
                  const connection = settings.search.find(
                    (entry) => entry.id === platform.id,
                  );
                  const count = observations.filter(
                    (observation) => observation.engine === platform.id,
                  ).length;
                  const section = connection?.id;
                  return (
                    <Fragment key={platform.id}>
                      <tr>
                        <th scope="row">{platform.name}</th>
                        <td>{platform.kind}</td>
                        <td>
                          <span
                            className={`cs-status ${connection?.configured ? 'cs-configured' : ''}`}
                          >
                            {connection
                              ? connection.configured
                                ? '已配置'
                                : '未配置'
                              : '未接自动采集'}
                          </span>
                        </td>
                        <td>
                          {count ? (
                            <button
                              type="button"
                              className="cs-link"
                              onClick={() => onRecords(platform.id)}
                            >
                              {count} 条记录
                            </button>
                          ) : (
                            <span className="cs-muted">本批暂无</span>
                          )}
                        </td>
                        <td className="cs-row-actions">
                          {connection && section ? (
                            <>
                              <button
                                type="button"
                                className="cs-link"
                                disabled={!!busy}
                                aria-expanded={editing === section}
                                onClick={() => {
                                  setEditing(
                                    editing === section ? null : section,
                                  );
                                  setSearchDraft({
                                    apiKey: '',
                                    model: connection.model || '',
                                  });
                                  setTestConfirmation(null);
                                  report(section, {});
                                }}
                              >
                                {editing === section
                                  ? '收起'
                                  : connection.configured
                                    ? '编辑'
                                    : '配置'}
                              </button>
                              <button
                                type="button"
                                className="cs-link"
                                disabled={
                                  !!busy ||
                                  !connection.configured ||
                                  editing === section
                                }
                                onClick={() => setTestConfirmation(section)}
                              >
                                {busy === `test:${section}`
                                  ? '测试中…'
                                  : '测试连接'}
                              </button>
                            </>
                          ) : (
                            <span className="cs-muted">仅查看已有记录</span>
                          )}
                        </td>
                      </tr>
                      {connection &&
                        section &&
                        (editing === section ||
                          feedback[section]?.error ||
                          feedback[section]?.message ||
                          testConfirmation === section) && (
                          <tr className="cs-detail-row">
                            <td colSpan={5}>
                              {editing === section && (
                                <form
                                  onSubmit={(event) => {
                                    event.preventDefault();
                                    void save(section, {
                                      apiKey: searchDraft.apiKey,
                                      ...(connection.model !== null
                                        ? { model: searchDraft.model }
                                        : {}),
                                    });
                                  }}
                                >
                                  <div className="cs-search-fields">
                                    <label>
                                      {platform.name} API Key
                                      <input
                                        type="password"
                                        value={searchDraft.apiKey}
                                        required={!connection.keyConfigured}
                                        autoComplete="new-password"
                                        spellCheck={false}
                                        placeholder={
                                          connection.keyConfigured
                                            ? '已设置，留空保留'
                                            : '填写 API Key'
                                        }
                                        onChange={(event) =>
                                          setSearchDraft({
                                            ...searchDraft,
                                            apiKey: event.target.value,
                                          })
                                        }
                                      />
                                    </label>
                                    {connection.model !== null && (
                                      <label>
                                        模型
                                        <input
                                          value={searchDraft.model}
                                          required
                                          onChange={(event) =>
                                            setSearchDraft({
                                              ...searchDraft,
                                              model: event.target.value,
                                            })
                                          }
                                        />
                                      </label>
                                    )}
                                    <button
                                      type="submit"
                                      className="cs-button cs-primary"
                                      disabled={!!busy}
                                    >
                                      {busy === `save:${section}` && (
                                        <Loader2 size={14} className="spin" />
                                      )}
                                      保存
                                    </button>
                                    <button
                                      type="button"
                                      className="cs-link"
                                      disabled={!!busy}
                                      onClick={() => {
                                        setEditing(null);
                                        setSearchDraft({
                                          apiKey: '',
                                          model: '',
                                        });
                                      }}
                                    >
                                      取消
                                    </button>
                                  </div>
                                  {connection.model !== null && (
                                    <p className="cs-hint">
                                      模型变更用于新搜索，已有跟测保持原条件。
                                    </p>
                                  )}
                                </form>
                              )}
                              {confirmation(section)}
                              {result(section)}
                            </td>
                          </tr>
                        )}
                    </Fragment>
                  );
                })}
            </tbody>
          </table>
        </div>
        <details className="cs-web-records">
          <summary>
            已有网页采集记录
            <ChevronDown size={14} className="cs-disclosure-chevron" />
          </summary>
          <div className="cs-web-record-list">
            {platforms
              .filter(
                (platform) =>
                  !settings.search.some((entry) => entry.id === platform.id),
              )
              .map((platform) => {
                const count = observations.filter(
                  (observation) => observation.engine === platform.id,
                ).length;
                return (
                  <div className="cs-web-record" key={platform.id}>
                    <div>
                      <strong>{platform.name}</strong>
                      <span>{platform.kind} · 未接自动采集</span>
                    </div>
                    {count ? (
                      <button
                        type="button"
                        className="cs-link"
                        onClick={() => onRecords(platform.id)}
                      >
                        {count} 条记录
                      </button>
                    ) : (
                      <span className="cs-muted">本批暂无</span>
                    )}
                  </div>
                );
              })}
          </div>
        </details>
      </section>
    </div>
  );
}

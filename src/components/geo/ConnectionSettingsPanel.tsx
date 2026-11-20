'use client';

import { useEffect, useState } from 'react';
import {
  Activity,
  ArrowRight,
  BrainCircuit,
  Check,
  FileText,
  Loader2,
  RefreshCw,
  Search,
} from 'lucide-react';
import type { GeoConnectionSettings } from '@/lib/geo/connection-settings-types';
import type { ResearchBatch, ResearchEngine } from '@/lib/geo/research-types';
import type { TrafficSnapshot } from '@/lib/geo/traffic-types';
import ModelSettingsCard from './ModelSettingsCard';
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
type Feedback = { error?: string; message?: string };
const platforms: {
  id: ResearchEngine;
  name: string;
  kind: { en: string; zh: string };
}[] = [
  { id: 'chatgpt', name: 'ChatGPT', kind: { en: 'Web answers', zh: '网页回答' } },
  { id: 'google', name: 'Google', kind: { en: 'Web search', zh: '网页搜索' } },
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
  const [loadError, setLoadError] = useState('');
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
        if (!response.ok) {
          throw new Error(
            body.error ||
              (isEn ? 'Failed to load settings.' : '读取设置失败。'),
          );
        }
        return body as GeoConnectionSettings;
      })
      .then((next) => {
        setSettings(next);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setLoadError(
            error instanceof Error
              ? error.message
              : isEn
                ? 'Failed to load settings.'
                : '读取设置失败。',
          );
        }
      });
    return () => controller.abort();
  }, [isEn]);

  useEffect(() => {
    if (!settings) return;
    const scrollToHash = () => {
      if (window.location.hash === '#model') {
        document
          .getElementById('model')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };
    scrollToHash();
    window.addEventListener('hashchange', scrollToHash);
    return () => window.removeEventListener('hashchange', scrollToHash);
  }, [settings]);

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
        if (!response.ok) {
          throw new Error(
            body.error ||
              (isEn
                ? 'Failed to load project fact sheet.'
                : '读取项目事实档案失败。'),
          );
        }
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
  }, [projectId, isEn]);

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
      if (!response.ok) {
        throw new Error(
          body.error ||
            (isEn
              ? 'Failed to save project fact sheet.'
              : '保存项目事实档案失败。'),
        );
      }
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
          : '已保存到 project-context.md，后续的问题规划、撰写草稿与审核将自动读取这份档案。',
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
          <ModelSettingsCard
            initialSettings={settings}
            onSaved={(next) => {
              setSettings(next);
              onSaved();
            }}
          />
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
                        ? `${platform.kind.en} · Local browser capture`
                        : `${platform.kind.zh} · 浏览器真实采集`}
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
              {isEn ? (
                <>
                  Project fact sheet (<code>project-context.md</code>)
                </>
              ) : (
                <>
                  项目事实档案（<code>project-context.md</code>）
                </>
              )}
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

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  Check,
  Clock,
  FileStack,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import type { HumanProgressStep } from '@/lib/agent-hub';
import type { OptimizationRunStatus } from '@/lib/geo/db/schema';
import type { OptimizationRunViewModel } from '@/lib/geo/optimization/types';
import {
  estimateReadingMinutes,
  extractDeliverablePurpose,
  extractFirstScreenshotSrc,
  extractPackageThumbnails,
  extractPlainLeadExcerpt,
  getDeliverableRoleLabel,
} from './DeliverableArticleView';
import { useChineseCompanionPreference, useUiLanguage } from './UiLanguageContext';
import './optimization-hero-card.css';

export interface HeroCitedSource {
  key: string;
  label: string;
  url: string;
  questionCount: number;
}

export interface HeroNextOutreach {
  id: string;
  kind: 'awesome_pr' | 'repo_meta' | 'community_post';
  title: string;
  citedCount: number;
  targetUrl: string;
}

export interface OptimizationHeroCardProps {
  projectId: string;
  questionCount: number;
  missedQuestionCount?: number;
  topCitedSources?: HeroCitedSource[];
  onOpenStudio: (runId?: string) => void;
  onOpenQuestions: () => void;
  onStatusChange?: (viewModel: OptimizationRunViewModel | null) => void;
}

function parseHeroDiagnosis(
  rawSummary: string,
  questionCount: number,
  gapCount: number,
  isEn = false,
): { lead: string; bullets: string[] } {
  const defaultLead = isEn
    ? gapCount > 0
      ? `Across ${questionCount} buyer-intent prompts, ${gapCount} missed your product:`
      : 'Three complementary improvements are ready based on real AI search gaps:'
    : gapCount > 0
      ? `客户常问的 ${questionCount} 道问题里有 ${gapCount} 道没提到你，主要卡在两处：`
      : '结合客户在各平台的真实提问，为你准备了以下配套改进内容：';

  const trimmed = rawSummary.replace(/\r/g, '').trim();
  if (!trimmed) {
    return { lead: defaultLead, bullets: [] };
  }

  if (isEn && /[\u4e00-\u9fff]/.test(trimmed)) {
    return {
      lead: defaultLead,
      bullets: [
        'Brand queries mix OpenGEO with same-named open-geo projects because README clarity is missing.',
        'Category & how-to searches cite cloud monitors instead of quickstarts or practical workflow guides.',
      ],
    };
  }

  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const bulletRe = /^[-·•*]\s*(.+)$/;
  const bullets = lines
    .map((line) => line.match(bulletRe)?.[1]?.trim() || '')
    .filter(Boolean)
    .slice(0, 2)
    .map((b) => (b.length > 44 ? `${b.slice(0, 44).replace(/[，、：,\s]+$/, '')}…` : b));

  const nonBulletLines = lines.filter((line) => !bulletRe.test(line));
  if (bullets.length > 0 && nonBulletLines.length > 0) {
    const leadLine = nonBulletLines[0];
    return {
      lead: leadLine.length > 56 ? `${leadLine.slice(0, 56).replace(/[，、,\s]+$/, '')}` : leadLine,
      bullets,
    };
  }

  // Fallback for single-paragraph legacy summaries
  const sentences = trimmed
    .split(/[。！？]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const firstSentence = sentences[0] || defaultLead;
  const fallbackLead =
    firstSentence.length > 56
      ? `${firstSentence.slice(0, 56).replace(/[，、,\s]+$/, '')}。`
      : `${firstSentence}。`;
  return { lead: fallbackLead, bullets: [] };
}

function renderTopCitedStrip(topCitedSources: HeroCitedSource[], isEn: boolean) {
  if (!topCitedSources.length) return null;
  return (
    <div className="ohc-cited-row">
      <span className="ohc-cited-label">
        {isEn ? 'AI currently cites:' : 'AI 当前高频引用：'}
      </span>
      {topCitedSources.map((src) => (
        <a
          key={src.key}
          href={src.url}
          target="_blank"
          rel="noreferrer"
          className="ohc-cited-pill"
        >
          <span>{src.label}</span>
          <em>{isEn ? `${src.questionCount}q` : `${src.questionCount}题`}</em>
        </a>
      ))}
    </div>
  );
}

export default function OptimizationHeroCard({
  projectId,
  questionCount,
  missedQuestionCount = 0,
  topCitedSources = [],
  onOpenStudio,
  onOpenQuestions,
  onStatusChange,
}: OptimizationHeroCardProps) {
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const [includeChineseCompanion, setIncludeChineseCompanion] =
    useChineseCompanionPreference();
  const [viewModel, setViewModel] = useState<OptimizationRunViewModel | null>(null);
  const [topNextOutreach, setTopNextOutreach] = useState<HeroNextOutreach | null>(null);
  const [latestShippedAt, setLatestShippedAt] = useState<string | null>(null);
  const [mountNowMs] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [streamingStatus, setStreamingStatus] = useState<OptimizationRunStatus | null>(null);
  const [streamingSteps, setStreamingSteps] = useState<HumanProgressStep[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [startingRetest, setStartingRetest] = useState(false);
  const [error, setError] = useState('');
  const statusCallbackRef = useRef(onStatusChange);
  statusCallbackRef.current = onStatusChange;

  const loadStatus = useCallback(
    async (signal?: AbortSignal) => {
      if (!projectId) return;
      try {
        const res = await fetch(
          `/api/geo/optimization?project=${encodeURIComponent(projectId)}&lang=${uiLanguage}`,
          { cache: 'no-store', signal },
        );
        if (!res.ok) return;
        const payload = (await res.json()) as {
          viewModel?: OptimizationRunViewModel;
          topNextOutreach?: HeroNextOutreach | null;
          latestShippedAt?: string | null;
        };
        if (signal?.aborted) return;
        const nextVm = payload.viewModel ?? null;
        setViewModel(nextVm);
        if (payload.topNextOutreach !== undefined) {
          setTopNextOutreach(payload.topNextOutreach);
        }
        if (payload.latestShippedAt !== undefined) {
          setLatestShippedAt(payload.latestShippedAt);
        }
        statusCallbackRef.current?.(nextVm);
      } catch {
        // Keep last loaded state on transient network errors
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [projectId, uiLanguage],
  );

  useEffect(() => {
    setLoading(true);
    setError('');
    const controller = new AbortController();
    void loadStatus(controller.signal);
    return () => controller.abort();
  }, [loadStatus]);

  const run = viewModel?.run ?? null;
  const effectiveStatus = streamingStatus ?? run?.status ?? null;
  const isWorking =
    submitting ||
    (effectiveStatus !== null &&
      ['planning', 'drafting', 'reviewing', 'implementing', 'remeasuring'].includes(
        effectiveStatus,
      ));

  useEffect(() => {
    if (!isWorking || submitting) return;
    const id = setInterval(() => {
      void loadStatus();
    }, 3000);
    return () => clearInterval(id);
  }, [isWorking, submitting, loadStatus]);

  const executeStreamAction = async (action: 'start' | 'retry', targetRunId?: string) => {
    if (submitting || !projectId) return;
    setSubmitting(true);
    setError('');
    setStreamingSteps([]);
    setStreamingStatus(action === 'retry' ? 'drafting' : 'planning');

    try {
      const res = await fetch('/api/geo/optimization', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson',
        },
        body: JSON.stringify({
          projectId,
          action,
          mode: 'deep',
          includeChineseCompanion: uiLanguage === 'zh' ? includeChineseCompanion : false,
          ...(targetRunId ? { runId: targetRunId } : {}),
        }),
      });

      if (!res.ok || !res.body) {
        const fallback = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(fallback.error || (isEn ? 'Failed to start generation. Please try again.' : '启动生成失败，请稍后重试。'));
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const raw of lines) {
          const trimmed = raw.trim();
          if (!trimmed) continue;
          const evt = JSON.parse(trimmed) as
            | {
                type: 'progress';
                step: HumanProgressStep;
                runStatus: OptimizationRunStatus;
              }
            | { type: 'result'; viewModel: OptimizationRunViewModel }
            | { type: 'error'; error: string };

          if (evt.type === 'progress') {
            setStreamingStatus(evt.runStatus);
            setStreamingSteps((prev) => [...prev.slice(-7), evt.step]);
          } else if (evt.type === 'result') {
            setViewModel(evt.viewModel);
            statusCallbackRef.current?.(evt.viewModel);
            setStreamingStatus(null);
          } else if (evt.type === 'error') {
            setError(evt.error);
          }
        }
      }
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : '内容生成中断，请稍后重试。');
    } finally {
      setSubmitting(false);
      setStreamingStatus(null);
    }
  };

  if (loading && !viewModel) {
    return (
      <section className="ohc-stage is-loading" aria-label="下一步行动加载中">
        <div className="ohc-loading-row">
          <Loader2 size={16} className="ohc-spin" />
          <span>正在准备你的下一步建议…</span>
        </div>
      </section>
    );
  }

  const deliverables = run?.deliverables ?? [];
  const primary = deliverables[0] ?? null;
  const coveredCount = primary?.questionIds.length ?? 0;
  const gapCount = missedQuestionCount || coveredCount;
  const progressList = streamingSteps.length ? streamingSteps : (run?.progress ?? []);
  const latestStep = progressList[progressList.length - 1] ?? null;
  const retestSummary = viewModel?.retestComparison ?? null;

  // 1. Working state: live human progress
  if (isWorking) {
    const activePhase =
      effectiveStatus === 'planning'
        ? 1
        : effectiveStatus === 'drafting'
          ? 2
          : effectiveStatus === 'reviewing'
            ? 3
            : 2;
    return (
      <section className="ohc-stage is-working" aria-label="正在准备改进内容">
        <div className="ohc-working-wrap">
          <div className="ohc-eyebrow is-live">
            <Loader2 size={13} className="ohc-spin" />
            <span>正在为你准备内容</span>
          </div>
          <h2 className="ohc-headline">
            正在根据 AI 没提到你的问题，准备配套改进内容
          </h2>
          <div className="ohc-live-phases" aria-label="当前进度">
            <span className={activePhase >= 1 ? 'is-active' : ''}>
              {activePhase > 1 ? <Check size={12} /> : <b>1</b>} 梳理曝光短板
            </span>
            <i />
            <span className={activePhase >= 2 ? 'is-active' : ''}>
              {activePhase > 2 ? <Check size={12} /> : <b>2</b>} 撰写图文正文
            </span>
            <i />
            <span className={activePhase >= 3 ? 'is-active' : ''}>
              <b>3</b> 核对事实与可读性
            </span>
          </div>
          <p className="ohc-live-detail">
            {latestStep?.message ||
              run?.statusMessage ||
              '正在对照真实回答梳理切入角度，完成后会通知你过目…'}
          </p>
        </div>
      </section>
    );
  }

  // 2. Flagship state: Awaiting human review & approval
  if (effectiveStatus === 'awaiting_approval' && primary && run) {
    const isMulti = deliverables.length > 1;
    const appliedCount = deliverables.filter((d) => d.status === 'applied').length;
    const readyCount = deliverables.filter((d) => d.status === 'ready').length;
    const allReviewed = deliverables.every((d) => d.review?.verdict === 'pass');
    const allAuthorVerified =
      allReviewed &&
      deliverables.every((d) => d.review?.reviewerModel === 'author-verified');
    const uniqueQuestionCount = new Set(deliverables.flatMap((d) => d.questionIds)).size;
    const totalTables = deliverables.reduce(
      (sum, d) => sum + d.mediaManifest.filter((m) => m.type === 'table').length,
      0,
    );

    const packageThumbs = extractPackageThumbnails(projectId, deliverables, 3);
    const diagnosis = parseHeroDiagnosis(run.summary || '', questionCount, gapCount, isEn);
    const leadExcerpt = extractPlainLeadExcerpt(primary.afterContent, 108);
    const firstShot = extractFirstScreenshotSrc(projectId, primary);
    const readMins = estimateReadingMinutes(primary.afterContent);

    return (
      <section className="ohc-stage is-hero" aria-label={isEn ? 'Recommended next actions' : '下一步行动建议'}>
        <div className="ohc-hero-grid">
          <div className="ohc-story">
            <div className="ohc-eyebrow">
              <Sparkles size={13} />
              <span>{isEn ? 'Next step · Ready for review' : '下一步 · 等你过目'}</span>
            </div>

            <h2 className="ohc-headline">
              {isMulti
                ? appliedCount > 0 && readyCount > 0
                  ? isEn
                    ? `${appliedCount} adopted, ${readyCount} waiting for your review`
                    : `已采用 ${appliedCount} 份，还有 ${readyCount} 份等你过目`
                  : isEn
                    ? `${deliverables.length} complementary deliverables prepared`
                    : `为你备好了 ${deliverables.length} 份配套改进方案`
                : primary.kind === 'update_asset'
                  ? isEn
                    ? 'Updated project documentation ready for review'
                    : '为你改好了对外介绍内容，看看能不能用'
                  : isEn
                    ? 'New acquisition article ready for review'
                    : '为你写好了一篇获客文章，看看能不能发'}
            </h2>

            <p className="ohc-why">{diagnosis.lead}</p>

            {diagnosis.bullets.length > 0 && (
              <ul className="ohc-gap-bullets">
                {diagnosis.bullets.map((bullet, idx) => (
                  <li key={idx}>{bullet}</li>
                ))}
              </ul>
            )}

            {renderTopCitedStrip(topCitedSources, isEn)}

            {!isMulti && (
              <ol className="ohc-safe-steps" aria-label={isEn ? '3-step workflow' : '后续三步流程'}>
                <li>
                  <b>1</b>
                  <span>{isEn ? 'Inspect full draft' : '先看图文全文'}</span>
                </li>
                <li className="ohc-step-sep" aria-hidden="true">
                  →
                </li>
                <li>
                  <b>2</b>
                  <span>{isEn ? 'Publish when satisfied' : '你满意后再发布'}</span>
                </li>
                <li className="ohc-step-sep" aria-hidden="true">
                  →
                </li>
                <li>
                  <b>3</b>
                  <span>{isEn ? 'Re-audit same prompts' : '原题重测看变化'}</span>
                </li>
              </ol>
            )}

            <div className="ohc-cta-row">
              <button
                type="button"
                className="ohc-cta-primary"
                onClick={() => onOpenStudio(run.id)}
              >
                <span>
                  {isMulti
                    ? (isEn ? 'Review & decide piece by piece' : '逐篇查看，决定采用哪些')
                    : (isEn ? 'Read full draft & decide' : '阅读全文，决定是否采用')}
                </span>
                <ArrowRight size={16} />
              </button>
              {isMulti && (
                <span className="ohc-cta-note">
                  {isEn
                    ? 'Adopt individually — nothing changes without approval'
                    : '可按需单篇采用，未经确认不会改动现有内容'}
                </span>
              )}
            </div>
          </div>

          {isMulti ? (
            <div
              className="ohc-package-card"
              aria-label={isEn ? `${deliverables.length} deliverables in package` : `本轮配套方案清单，共 ${deliverables.length} 份`}
            >
              <div className="ohc-pkg-head">
                <span className="ohc-pkg-kicker">
                  <FileStack size={13.5} />
                  <span>
                    {isEn
                      ? `Deliverable package · ${deliverables.length} drafts`
                      : `配套改进清单 · 共 ${deliverables.length} 份`}
                  </span>
                </span>
                {allReviewed && (
                  <span className="ohc-paper-verified">
                    <ShieldCheck size={12.5} />
                    {allAuthorVerified
                      ? isEn
                        ? 'Author verified'
                        : '作者已核对'
                      : isEn
                        ? 'Reviewed for accuracy & clarity'
                        : '已核对事实与可读性'}
                  </span>
                )}
              </div>

              <ol className="ohc-pkg-list">
                {deliverables.map((d, idx) => {
                  const isDone = d.status === 'applied';
                  const isSkipped = d.status === 'skipped';
                  const rawPurpose = extractDeliverablePurpose(d, isEn ? 68 : 46);
                  const purpose =
                    isEn && /[\u4e00-\u9fff]/.test(rawPurpose)
                      ? extractPlainLeadExcerpt(d.afterContent, 68)
                      : rawPurpose;
                  return (
                    <li
                      key={d.id}
                      className={`ohc-pkg-item ${isDone ? 'is-applied' : isSkipped ? 'is-skipped' : ''}`}
                    >
                      <span className="ohc-pkg-num" aria-hidden="true">
                        {isDone ? <Check size={11.5} strokeWidth={3} /> : isSkipped ? '–' : idx + 1}
                      </span>
                      <div className="ohc-pkg-body">
                        <div className="ohc-pkg-meta">
                          <span className="ohc-pkg-role">{getDeliverableRoleLabel(d, uiLanguage)}</span>
                          <span className="ohc-pkg-mins">
                            {isEn
                              ? `~${estimateReadingMinutes(d.afterContent)} min read`
                              : `约 ${estimateReadingMinutes(d.afterContent)} 分钟`}
                          </span>
                          {(isDone || isSkipped) && (
                            <span className={`ohc-pkg-state ${isDone ? 'is-done' : 'is-skip'}`}>
                              {isDone
                                ? d.appliedRecord?.mode === 'local_file'
                                  ? (isEn ? 'Pending push' : '待推送上线')
                                  : (isEn ? 'Published' : '已上线')
                                : (isEn ? 'Skipped' : '暂不采用')}
                            </span>
                          )}
                        </div>
                        <h3 className="ohc-pkg-title">{d.title}</h3>
                        <p className="ohc-pkg-purpose">{purpose}</p>
                      </div>
                    </li>
                  );
                })}
              </ol>

              {(packageThumbs.length > 0 || uniqueQuestionCount > 0) && (
                <div className="ohc-pkg-foot">
                  {packageThumbs.length > 0 && (
                    <div className="ohc-pkg-thumbs" aria-hidden="true">
                      {packageThumbs.map((thumb) => (
                        <span key={thumb.src} className="ohc-pkg-thumb">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={thumb.src} alt="" loading="lazy" />
                        </span>
                      ))}
                    </div>
                  )}
                  <span className="ohc-pkg-summary">
                    {isEn
                      ? `Addresses ${uniqueQuestionCount} buyer prompts${totalTables > 0 ? ` · ${totalTables} comparison tables` : ''}`
                      : `回应 ${uniqueQuestionCount} 道客户问题${totalTables > 0 ? ` · 含 ${totalTables} 张实用对照表` : ''}`}
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div className="ohc-paper-preview" aria-label={isEn ? `Draft preview: ${primary.title}` : `内容预览：${primary.title}`}>
              <div className="ohc-paper-top">
                <span className="ohc-paper-tag">
                  <BookOpen size={12} />
                  {getDeliverableRoleLabel(primary, uiLanguage)} ·{' '}
                  {isEn ? `~${readMins} min read` : `约 ${readMins} 分钟读完`}
                </span>
                {primary.review?.verdict === 'pass' && (
                  <span className="ohc-paper-verified">
                    <ShieldCheck size={12.5} />
                    {primary.review.reviewerModel === 'author-verified'
                      ? isEn
                        ? 'Author verified'
                        : '作者已核对'
                      : isEn
                        ? 'Verified facts'
                        : '已核对事实'}
                  </span>
                )}
              </div>

              <h3 className="ohc-paper-title">{primary.title}</h3>

              {leadExcerpt && <p className="ohc-paper-excerpt">{leadExcerpt}</p>}

              {firstShot && (
                <div className="ohc-paper-shot">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={firstShot.src} alt={firstShot.caption} loading="lazy" />
                </div>
              )}
            </div>
          )}
        </div>

        {error && <p className="ohc-error">{error}</p>}
      </section>
    );
  }

  // 3. Awaiting retest & Completed helpers (action-type-aware copy + post-indexing retest trigger)
  const formatNextOutreachCta = (next: HeroNextOutreach | null): string => {
    if (!next) return isEn ? 'Open Action Plan' : '查看优化方案';
    if (next.kind === 'awesome_pr') {
      return isEn ? `Next: Submit PR to ${next.title}` : `下一步：向 ${next.title} 提榜单 PR`;
    }
    if (next.kind === 'repo_meta') {
      return isEn ? 'Next: Sync GitHub About & Topics' : '下一步：补齐 GitHub 仓库简介与标签';
    }
    if (next.id.startsWith('post:thread:')) {
      return isEn ? `Next: Reply in ${next.title}` : `下一步：参与高引用讨论`;
    }
    return isEn ? `Next: Share on ${next.title}` : `下一步：前往「${next.title}」发布分享`;
  };

  const formatNextOutreachHeadline = (
    next: HeroNextOutreach,
    stage: 'awaiting' | 'indexing' | 'post_window',
  ): string => {
    const prefixEn =
      stage === 'awaiting'
        ? 'Docs are live'
        : stage === 'indexing'
          ? 'Recent updates are still indexing'
          : 'No lift yet';
    const prefixZh =
      stage === 'awaiting'
        ? '内容已上线'
        : stage === 'indexing'
          ? '最近上线的内容还在收录期内'
          : '暂未新增提及';

    if (next.kind === 'awesome_pr') {
      if (isEn) {
        return stage === 'awaiting'
          ? `Docs are live — next, submit your PR to ${next.title}`
          : stage === 'indexing'
            ? `Recent updates are still indexing — next, submit a PR to ${next.title}`
            : `No lift yet — next, submit your PR to ${next.title}`;
      }
      return stage === 'awaiting'
        ? `内容已上线，趁收录期间先提交「${next.title}」榜单 PR`
        : stage === 'indexing'
          ? `最近上线的内容还在收录期内；这期间先去提交「${next.title}」PR`
          : `暂未新增提及；下一步先提「${next.title}」榜单 PR`;
    }

    if (next.kind === 'repo_meta') {
      return isEn
        ? `${prefixEn} — next, sync your GitHub repo description & topics`
        : `${prefixZh}；下一步先补齐 GitHub 仓库简介与 Topics`;
    }

    if (next.id.startsWith('post:thread:')) {
      return isEn
        ? `${prefixEn} — next, join cited thread "${next.title}"`
        : `${prefixZh}；下一步可参与高引用讨论「${next.title}」`;
    }

    return isEn
      ? `${prefixEn} — next, share on ${next.title}`
      : `${prefixZh}；下一步可去「${next.title}」发布分享`;
  };

  const triggerPostIndexingRetest = async (runId: string) => {
    if (startingRetest || !projectId) return;
    setStartingRetest(true);
    setError('');
    try {
      const res = await fetch('/api/geo/browser-collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start',
          projectId,
          engine: 'all',
          force: true,
          optimizationRunId: runId,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(
          payload.error ||
            (isEn ? 'Failed to start post-indexing retest.' : '启动原题复测失败，请稍后重试。'),
        );
      }
      window.dispatchEvent(new Event('focus'));
      await loadStatus();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : isEn
            ? 'Failed to start post-indexing retest.'
            : '启动原题复测失败，请稍后重试。',
      );
    } finally {
      setStartingRetest(false);
    }
  };

  if (effectiveStatus === 'awaiting_retest' && run) {
    const appliedList = deliverables.filter((d) => d.status === 'applied');
    const unpushedLocalCount = appliedList.filter((d) => d.appliedRecord?.mode === 'local_file').length;
    const onlineCount = appliedList.filter((d) => d.appliedRecord?.mode !== 'local_file').length;
    const needsGitHubPushFirst = unpushedLocalCount > 0 && onlineCount === 0;

    return (
      <section className="ohc-stage is-retest" aria-label={isEn ? 'Next step: publish and wait for indexing' : '下一步：发布上线与等待复测'}>
        <div className="ohc-single-layout">
          <div className="ohc-story">
            <div className="ohc-eyebrow">
              <RefreshCw size={13} />
              <span>
                {needsGitHubPushFirst
                  ? isEn
                    ? 'Next · Push to GitHub'
                    : '下一步 · 推送到线上仓库'
                  : isEn
                    ? 'Indexing window · Waiting for search engines'
                    : '收录观察期 · 等待搜索引擎更新'}
              </span>
            </div>
            <h2 className="ohc-headline">
              {needsGitHubPushFirst
                ? isEn
                  ? `${unpushedLocalCount} local draft(s) ready to push to GitHub`
                  : `已采用 ${unpushedLocalCount} 套本地文档，尚未推送到 GitHub 线上仓库`
                : topNextOutreach
                  ? formatNextOutreachHeadline(topNextOutreach, 'awaiting')
                  : isEn
                    ? 'Updates are live — wait 3–7 days for indexing before retesting'
                    : '新内容已上线，建议等待 3～7 天收录后再按原题复测'}
            </h2>
            <p className="ohc-why">
              {needsGitHubPushFirst
                ? isEn
                  ? 'Local edits are not visible to AI search yet. Open Action Plan to push them cleanly to your default branch.'
                  : '目前改动只保存在本机电脑上，AI 搜索还抓取不到。点击右侧即可一键推送到 GitHub。'
                : isEn
                  ? 'Search engines typically take 3–7 days to re-index new pages. Tackle external AI-cited lists while indexing settles.'
                  : '搜索引擎建立网页索引通常需要 3～7 天；等待期间可以先拿下已经被 AI 直接引用的外部榜单或社区渠道。'}
            </p>
            {renderTopCitedStrip(topCitedSources, isEn)}
          </div>
          <button
            type="button"
            className="ohc-cta-primary"
            onClick={() => onOpenStudio(run.id)}
          >
            <span>
              {needsGitHubPushFirst
                ? isEn
                  ? 'Push docs to GitHub'
                  : '前往优化方案推送'
                : formatNextOutreachCta(topNextOutreach)}
            </span>
            <ArrowRight size={16} />
          </button>
        </div>
      </section>
    );
  }

  // 4. Completed: distinguish indexing window, overdue stale retest ("Retest due"), and genuine post-window re-audit
  if (effectiveStatus === 'completed' && run) {
    const hasImprovement = retestSummary
      ? retestSummary.afterMentionYes > retestSummary.beforeMentionYes ||
        retestSummary.afterCitationYes > retestSummary.beforeCitationYes
      : false;
    const compared = retestSummary?.comparedCount ?? 0;
    const beforeM = retestSummary?.beforeMentionYes ?? 0;
    const afterM = retestSummary?.afterMentionYes ?? 0;
    const beforeC = retestSummary?.beforeCitationYes ?? 0;
    const afterC = retestSummary?.afterCitationYes ?? 0;

    const shippedMs = latestShippedAt ? Date.parse(latestShippedAt) : NaN;
    const elapsedHours = Number.isFinite(shippedMs)
      ? Math.max(0, (mountNowMs - shippedMs) / 3_600_000)
      : null;
    const retestIso = retestSummary?.latestRetestAt ?? run.updatedAt;
    const retestMs = retestIso ? Date.parse(retestIso) : NaN;
    const retestAfterShipHours =
      Number.isFinite(shippedMs) && Number.isFinite(retestMs)
        ? (retestMs - shippedMs) / 3_600_000
        : null;
    const retestRanAfterWindow =
      elapsedHours === null ? true : retestAfterShipHours !== null && retestAfterShipHours >= 72;

    const withinIndexingWindow =
      !hasImprovement && !retestRanAfterWindow && elapsedHours !== null && elapsedHours < 7 * 24;
    const retestDue =
      !hasImprovement && !retestRanAfterWindow && elapsedHours !== null && elapsedHours >= 7 * 24;
    const indexingDay =
      elapsedHours !== null ? Math.min(7, Math.max(1, Math.floor(elapsedHours / 24) + 1)) : 1;

    if (withinIndexingWindow) {
      return (
        <section
          className="ohc-stage is-retest"
          aria-label={isEn ? 'Indexing window in progress' : '等待搜索引擎收录观察期'}
        >
          <div className="ohc-single-layout">
            <div className="ohc-story">
              <div className="ohc-eyebrow">
                <Clock size={13} />
                <span>
                  {isEn
                    ? `Day ${indexingDay} since publish · Waiting for search indexing (3–7 days)`
                    : `已上线第 ${indexingDay} 天 · 等待搜索引擎收录（通常需 3～7 天）`}
                </span>
              </div>
              <h2 className="ohc-headline">
                {topNextOutreach
                  ? formatNextOutreachHeadline(topNextOutreach, 'indexing')
                  : isEn
                    ? 'Updates are still inside the 3–7 day search indexing window'
                    : '新内容仍在搜索引擎收录观察期内，满 3～7 天后再重测更有意义'}
              </h2>
              <p className="ohc-why">
                {isEn
                  ? `Early re-checks (${beforeM} → ${afterM} across ${compared} answers) hit pre-index caches rather than reflecting the new docs.${topNextOutreach ? ' Tackle the top AI-cited outreach channel next while indexing settles.' : ''}`
                  : `刚推送完不久重测（${beforeM} → ${afterM}，共 ${compared} 条）多半命中旧缓存，不代表改稿无效。${topNextOutreach ? '等待期间建议先推进排名第一的外链/榜单曝光渠道。' : ''}`}
              </p>
              {renderTopCitedStrip(topCitedSources, isEn)}
            </div>
            <button
              type="button"
              className="ohc-cta-primary"
              onClick={() => onOpenStudio(run.id)}
            >
              <span>{formatNextOutreachCta(topNextOutreach)}</span>
              <ArrowRight size={16} />
            </button>
          </div>
        </section>
      );
    }

    if (retestDue && elapsedHours !== null) {
      const liveDays = Math.floor(elapsedHours / 24);
      const earlyCheckHours = Math.max(1, Math.round(Math.max(0, retestAfterShipHours ?? 0)));
      return (
        <section
          className="ohc-stage is-retest"
          aria-label={isEn ? 'Post-indexing retest due' : '收录期已满 · 待运行复测'}
        >
          <div className="ohc-single-layout">
            <div className="ohc-story">
              <div className="ohc-eyebrow">
                <RefreshCw size={13} />
                <span>
                  {isEn
                    ? 'Indexing window complete · Retest due'
                    : '收录观察期已满 · 可按原题复测'}
                </span>
              </div>
              <h2 className="ohc-headline">
                {isEn
                  ? `Updates have been live ${liveDays} days — run a fresh post-indexing retest`
                  : `内容已上线满 ${liveDays} 天，现在可以跑一轮正式复测了`}
              </h2>
              <p className="ohc-why">
                {isEn
                  ? `Your previous re-check (${beforeM} → ${afterM} across ${compared} answers) ran ~${earlyCheckHours}h after shipping, before search engines could index the changes. Run a fresh retest now to measure actual movement.`
                  : `上次复测（${beforeM} → ${afterM}，共 ${compared} 条）是在上线约 ${earlyCheckHours} 小时后跑的，当时还没完成收录；现在重测才能看到真实变化。`}
              </p>
              {renderTopCitedStrip(topCitedSources, isEn)}
            </div>
            <button
              type="button"
              className="ohc-cta-primary"
              disabled={startingRetest}
              onClick={() => void triggerPostIndexingRetest(run.id)}
            >
              {startingRetest ? (
                <>
                  <Loader2 size={15} className="ohc-spin" />
                  <span>{isEn ? 'Starting retest…' : '正在启动复测…'}</span>
                </>
              ) : (
                <>
                  <RefreshCw size={15} />
                  <span>{isEn ? 'Run post-indexing retest' : '立即运行原题复测'}</span>
                </>
              )}
            </button>
          </div>
          {error && <p className="ohc-error">{error}</p>}
        </section>
      );
    }

    return (
      <section
        className={`ohc-stage ${hasImprovement ? 'is-completed' : 'is-warn'}`}
        aria-label={isEn ? 'Optimization retest summary' : '本轮复测结果'}
      >
        <div className="ohc-single-layout">
          <div className="ohc-story">
            <div className={`ohc-eyebrow ${hasImprovement ? '' : 'is-warn'}`.trim()}>
              {hasImprovement ? <Check size={13} /> : <Clock size={13} />}
              <span>
                {hasImprovement
                  ? isEn
                    ? 'Re-audit completed'
                    : '本轮改进已完成复测'
                  : isEn
                    ? 'Re-audit · No lift after indexing window'
                    : '收录期后复测 · 暂未见明显提升'}
              </span>
            </div>
            <h2 className="ohc-headline">
              {hasImprovement
                ? isEn
                  ? 'Before vs after comparison shows movement'
                  : '已完成改进前后的同题表现对比'
                : topNextOutreach
                  ? formatNextOutreachHeadline(topNextOutreach, 'post_window')
                  : isEn
                    ? 'No mention or citation lift yet'
                    : '本轮上线并复测后，暂未出现新增提及或引用'}
            </h2>
            <p className="ohc-why">
              {retestSummary
                ? isEn
                  ? hasImprovement
                    ? `Retested ${compared} answers: mentions ${beforeM} → ${afterM}, official citations ${beforeC} → ${afterC}.`
                    : `Retested ${compared} answers: mentions ${beforeM} → ${afterM}, official citations ${beforeC} → ${afterC}. Open Action Plan to tackle the highest-impact cited lists next.`
                  : hasImprovement
                    ? `共复测 ${compared} 条问答：AI 提及从 ${beforeM} 条变为 ${afterM} 条，官网引用从 ${beforeC} 条变为 ${afterC} 条。`
                    : `共复测 ${compared} 条问答：提及 ${beforeM} → ${afterM} 条，引用 ${beforeC} → ${afterC} 条。打开「优化方案」按推荐顺序逐项拿下外部高引用渠道。`
                : run.statusMessage ||
                  (isEn
                    ? 'Inspect answer-by-answer comparisons or start a new round.'
                    : '可查看逐题回答对比，或针对其余未提及问题开启下一轮改进。')}
            </p>
            {renderTopCitedStrip(topCitedSources, isEn)}
          </div>
          <button
            type="button"
            className="ohc-cta-primary"
            onClick={() => onOpenStudio(run.id)}
          >
            <span>
              {hasImprovement
                ? isEn
                  ? 'Open Action Plan'
                  : '查看优化方案'
                : formatNextOutreachCta(topNextOutreach)}
            </span>
            <ArrowRight size={16} />
          </button>
        </div>
      </section>
    );
  }

  // 5. Failed / Paused: 1-click resume
  if (effectiveStatus === 'failed' && run) {
    return (
      <section className="ohc-stage is-failed" aria-label="本轮内容准备已暂停">
        <div className="ohc-single-layout">
          <div className="ohc-story">
            <div className="ohc-eyebrow is-warn">
              <RotateCcw size={13} />
              <span>内容准备中途暂停</span>
            </div>
            <h2 className="ohc-headline">
              {isEn ? 'Your previous draft progress is saved and ready to resume' : '刚才的草稿进度已保留，可以接着继续完成'}
            </h2>
            <p className="ohc-why">
              {run.errorMessage || (isEn ? 'Network or model timed out temporarily. Click the button on the right to continue.' : '网络或模型响应暂时超时，不需要重头再来，点击右侧即可接着完成。')}
            </p>
          </div>
          <div className="ohc-action-col">
            <button
              type="button"
              className="ohc-cta-primary"
              onClick={() => void executeStreamAction('retry', run.id)}
            >
              <span>{isEn ? 'Continue from last step' : '接着刚才的进度继续'}</span>
              <ArrowRight size={16} />
            </button>
            {uiLanguage === 'zh' && (
              <label className="ohc-companion-toggle">
                <input
                  type="checkbox"
                  checked={includeChineseCompanion}
                  onChange={(e) => setIncludeChineseCompanion(e.target.checked)}
                />
                <span>同时生成中文对照版</span>
              </label>
            )}
          </div>
        </div>
        {error && <p className="ohc-error">{error}</p>}
      </section>
    );
  }

  // 6. Idle (no optimization started yet)
  return (
    <section className="ohc-stage is-idle" aria-label={isEn ? 'Start optimization drafts' : '开始首轮内容改进'}>
      <div className="ohc-single-layout">
        <div className="ohc-story">
          <div className="ohc-eyebrow">
            <Sparkles size={13} />
            <span>{isEn ? 'Next step' : '下一步行动'}</span>
          </div>
          <h2 className="ohc-headline">
            {missedQuestionCount > 0
              ? isEn
                ? `Prepare tailored improvements for ${missedQuestionCount} missed prompts`
                : `针对 ${missedQuestionCount} 道没提到你的问题，准备配套改进方案`
              : isEn
                ? `Prepare improvements based on ${questionCount} tested prompts`
                : `根据这 ${questionCount} 道问题的实测结果，准备改进内容`}
          </h2>
          <p className="ohc-why">
            {isEn
              ? 'When AI answers skip your product, public docs are usually unclear or missing practical walkthroughs. Generate a package of drafts to inspect before publishing anything.'
              : 'AI 回答里没提你，通常是因为公开介绍还不够清楚或缺少直接解答客户疑问的内容。点击右侧按钮，我们会结合当前曝光缺口为你备好配套方案，先给你逐篇过目再决定采用哪些。'}
          </p>
          {renderTopCitedStrip(topCitedSources, isEn)}
        </div>

        {questionCount > 0 ? (
          <div className="ohc-action-col">
            <button
              type="button"
              className="ohc-cta-primary"
              onClick={() => void executeStreamAction('start')}
            >
              <span>{isEn ? 'Generate improvement drafts' : '生成改进内容草稿'}</span>
              <ArrowRight size={16} />
            </button>
            {uiLanguage === 'zh' && (
              <label className="ohc-companion-toggle">
                <input
                  type="checkbox"
                  checked={includeChineseCompanion}
                  onChange={(e) => setIncludeChineseCompanion(e.target.checked)}
                />
                <span>同时生成中文对照版</span>
              </label>
            )}
          </div>
        ) : (
          <button
            type="button"
            className="ohc-cta-primary"
            onClick={onOpenQuestions}
          >
            <span>{isEn ? 'Add customer prompts first' : '先添加客户常问的问题'}</span>
            <ArrowRight size={16} />
          </button>
        )}
      </div>
      {error && <p className="ohc-error">{error}</p>}
    </section>
  );
}

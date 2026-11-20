'use client';

import { useMemo, useState } from 'react';
import {
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  Sparkles,
} from 'lucide-react';
import {
  buildObservedCompetitorSnapshot,
  formatObservedCompetitorReportMarkdown,
} from '@/lib/geo/observed-competitors';
import { plural, resolveProjectTargetLanguage } from '@/lib/geo/i18n';
import { RESEARCH_ENGINE_NAMES } from '@/lib/geo/research-engines';
import type {
  ResearchBatch,
  ResearchEngine,
} from '@/lib/geo/research-types';
import type { GeoProject } from '@/lib/geo/types';
import GeoSelect from './GeoSelect';
import ResearchEngineIcon from './ResearchEngineIcon';
import { useUiLanguage } from './UiLanguageContext';
import './observed-competitor.css';

interface Props {
  project: GeoProject;
  batch: ResearchBatch | null | undefined;
  onOpenOverview: () => void;
  onOpenQuestions: () => void;
  onOpenActionPlan: () => void;
}

export default function ObservedCompetitorView({
  project,
  batch,
  onOpenOverview,
  onOpenQuestions,
  onOpenActionPlan,
}: Props) {
  const { uiLanguage, t } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const [engineFilter, setEngineFilter] = useState<'all' | ResearchEngine>('all');
  const [copiedReport, setCopiedReport] = useState(false);
  const [showAllWinners, setShowAllWinners] = useState(false);

  const targetLanguage = resolveProjectTargetLanguage(project, batch);

  const snapshot = useMemo(
    () =>
      buildObservedCompetitorSnapshot(batch, project, {
        language: targetLanguage,
        engine: engineFilter,
        maxCompetitors: 12,
      }),
    [batch, project, targetLanguage, engineFilter],
  );

  const handleCopyReport = async () => {
    const md = formatObservedCompetitorReportMarkdown(snapshot, isEn);
    try {
      await navigator.clipboard.writeText(md);
      setCopiedReport(true);
      window.setTimeout(() => setCopiedReport(false), 2000);
    } catch {
      // Ignore clipboard failure in restricted context
    }
  };

  if (!batch || snapshot.measuredAnswers === 0) {
    return (
      <div className="ocv-shell">
        <div className="ocv-empty-card">
          <h1>{t('term.whoAiRecommends')}</h1>
          <p>
            {isEn
              ? 'Run your first real AI search capture from Overview. Cited competitors and winning pages will appear here automatically—no manual setup required.'
              : '去「概览」完成首次真实 AI 搜索采集后，这里会自动统计谁正在霸占你的买家问题、靠哪些页面赢得引用，无需任何手填配置。'}
          </p>
          <button
            type="button"
            className="ocv-primary-btn"
            onClick={onOpenOverview}
          >
            {isEn ? 'Go to Overview' : '前往概览开始采集'}
            <ArrowRight size={14} />
          </button>
        </div>
      </div>
    );
  }

  const maxBarQuestions = Math.max(
    1,
    snapshot.totalQuestions,
    snapshot.ownCoveredQuestions,
    ...snapshot.competitors.slice(0, 5).map((c) => c.questionCount),
  );
  const visibleWinners = showAllWinners
    ? snapshot.competitors
    : snapshot.competitors.slice(0, 6);

  return (
    <div className="ocv-shell">
      <header className="ocv-topbar">
        <div className="ocv-title-group">
          <h1>{t('term.whoAiRecommends')}</h1>
          <span className="ocv-scope-pill">
            {isEn
              ? `${snapshot.totalQuestions} prompts · ${snapshot.measuredAnswers} answers${snapshot.latestObservedDate ? ` · ${snapshot.latestObservedDate}` : ''}`
              : `${snapshot.totalQuestions} 道买家问题 · ${snapshot.measuredAnswers} 条真实回答${snapshot.latestObservedDate ? ` · ${snapshot.latestObservedDate}` : ''}`}
          </span>
        </div>

        <div className="ocv-controls">
          <GeoSelect<'all' | ResearchEngine>
            label={isEn ? 'Platform' : '平台筛选'}
            value={engineFilter}
            onChange={setEngineFilter}
            options={[
              { value: 'all', label: isEn ? 'All platforms' : '全部平台' },
              { value: 'chatgpt', label: 'ChatGPT' },
              { value: 'google', label: 'Google' },
            ]}
          />
          <button
            type="button"
            className="ocv-secondary-btn"
            onClick={() => void handleCopyReport()}
          >
            {copiedReport ? <Check size={14} /> : <Copy size={14} />}
            <span>
              {copiedReport
                ? isEn
                  ? 'Copied report'
                  : '已复制战报'
                : isEn
                  ? 'Copy shareable summary'
                  : '复制汇报战报'}
            </span>
          </button>
          <button
            type="button"
            className="ocv-primary-btn"
            onClick={onOpenActionPlan}
          >
            <Sparkles size={14} />
            <span>{isEn ? 'Open Action Plan' : '打开行动计划'}</span>
          </button>
        </div>
      </header>

      {/* Row 1: Shareable Head-to-Head Scoreboard */}
      <section className="ocv-scoreboard" aria-label={isEn ? 'Competitive scoreboard' : '占位对比总览'}>
        <div className="ocv-card ocv-own-card">
          <div className="ocv-card-head">
            <span className="ocv-kicker">{isEn ? 'Your baseline' : '我方当前表现'}</span>
            <strong data-i18n-skip="">{snapshot.projectName}</strong>
          </div>
          <div className="ocv-own-stats">
            <div>
              <span className="ocv-big-num">
                {snapshot.ownCoveredQuestions}
                <small>/{snapshot.totalQuestions}</small>
              </span>
              <span className="ocv-stat-label">
                {isEn ? 'Prompts mentioned' : '题已被提及'}
              </span>
            </div>
            <div>
              <span className="ocv-big-num">
                {snapshot.ownCitationYes}
                <small>/{snapshot.measuredAnswers}</small>
              </span>
              <span className="ocv-stat-label">
                {t('term.siteCited')}
              </span>
            </div>
          </div>

          <div className="ocv-engine-breakdown">
            {snapshot.perEngine.map((item) => (
              <div key={item.engine} className="ocv-engine-row">
                <span className="ocv-engine-label">
                  <span className="ocv-engine-mini-icon">
                    <ResearchEngineIcon engine={item.engine} />
                  </span>
                  {RESEARCH_ENGINE_NAMES[item.engine]}
                </span>
                <span className="ocv-engine-val">
                  {isEn
                    ? `You ${item.ownMentionYes}/${item.measured}`
                    : `我方 ${item.ownMentionYes}/${item.measured}`}
                  {item.topWinner && (
                    <em>
                      {isEn ? (
                        <>
                          {' '}
                          · Top:{' '}
                          <span data-i18n-skip="">{item.topWinner.label}</span> (
                          {item.topWinner.questionCount}q)
                        </>
                      ) : (
                        <>
                          {' '}
                          · 领跑：
                          <span data-i18n-skip="">{item.topWinner.label}</span>
                          （{item.topWinner.questionCount} 题）
                        </>
                      )}
                    </em>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="ocv-card ocv-bars-card">
          <div className="ocv-card-head">
            <span className="ocv-kicker">
              {isEn ? 'Prompt coverage comparison' : '同题占位对比（被 AI 实际引用的对手）'}
            </span>
          </div>

          <div className="ocv-bar-list">
            <div className="ocv-bar-row is-own">
              <div className="ocv-bar-meta">
                <span className="ocv-bar-name">
                  <span data-i18n-skip="">{snapshot.projectName}</span>
                  <em>{isEn ? 'You' : '我方'}</em>
                </span>
                <span className="ocv-bar-count">
                  {snapshot.ownCoveredQuestions}/{snapshot.totalQuestions}
                  {isEn ? ' prompts' : ' 题'}
                </span>
              </div>
              <div className="ocv-bar-track">
                <div
                  className="ocv-bar-fill is-own"
                  style={{
                    width: `${Math.max(
                      snapshot.ownCoveredQuestions > 0 ? 6 : 0,
                      Math.round((snapshot.ownCoveredQuestions / maxBarQuestions) * 100),
                    )}%`,
                  }}
                />
              </div>
            </div>

            {snapshot.competitors.length === 0 ? (
              <p className="ocv-muted">
                {isEn
                  ? 'No external domains or repositories were cited in the captured answers for this filter.'
                  : '当前筛选范围内的回答未检测到外部被引用站点或仓库。'}
              </p>
            ) : (
              snapshot.competitors.slice(0, 5).map((comp) => (
                <div key={comp.key} className="ocv-bar-row">
                  <div className="ocv-bar-meta">
                    {comp.url ? (
                      <a
                        href={comp.url}
                        target="_blank"
                        rel="noreferrer"
                        className="ocv-bar-name ocv-bar-link"
                        data-i18n-skip=""
                      >
                        {comp.label}
                        <ExternalLink size={11} />
                      </a>
                    ) : (
                      <span className="ocv-bar-name" data-i18n-skip="">
                        {comp.label}
                      </span>
                    )}
                    <span className="ocv-bar-count">
                      {comp.questionCount}/{snapshot.totalQuestions}
                      {isEn ? ' prompts' : ' 题'}
                    </span>
                  </div>
                  <div className="ocv-bar-track">
                    <div
                      className="ocv-bar-fill"
                      style={{
                        width: `${Math.max(
                          8,
                          Math.round((comp.questionCount / maxBarQuestions) * 100),
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      {/* Row 2: Observed External Winners Detail Grid */}
      {snapshot.competitors.length > 0 && (
        <section className="ocv-section" aria-label={isEn ? 'Observed external winners' : '主要外部赢家'}>
          <div className="ocv-section-head">
            <div>
              <h2>{isEn ? 'Who AI cites most often' : '最常拿走推荐位的对手与渠道'}</h2>
              <p>
                {isEn
                  ? 'Derived directly from real captured citations—no separate analysis run needed.'
                  : '直接来自真实回答里的引用与来源，按覆盖题数排序。'}
              </p>
            </div>
            {snapshot.competitors.length > 6 && (
              <button
                type="button"
                className="ocv-inline-btn"
                onClick={() => setShowAllWinners((prev) => !prev)}
              >
                {showAllWinners
                  ? isEn
                    ? 'Show top 6'
                    : '收起至前 6 个'
                  : isEn
                    ? `Show all ${snapshot.competitors.length}`
                    : `展开全部 ${snapshot.competitors.length} 个`}
              </button>
            )}
          </div>

          <div className="ocv-winner-grid">
            {visibleWinners.map((comp) => (
              <article key={comp.key} className="ocv-winner-card">
                <div className="ocv-winner-top">
                  {comp.url ? (
                    <a
                      href={comp.url}
                      target="_blank"
                      rel="noreferrer"
                      className="ocv-winner-title"
                      data-i18n-skip=""
                    >
                      <strong>{comp.label}</strong>
                      <ExternalLink size={12} />
                    </a>
                  ) : (
                    <span className="ocv-winner-title" data-i18n-skip="">
                      <strong>{comp.label}</strong>
                    </span>
                  )}
                  <span className="ocv-winner-pill">
                    {isEn
                      ? `${comp.questionCount}/${snapshot.totalQuestions} prompts`
                      : `占 ${comp.questionCount}/${snapshot.totalQuestions} 题`}
                  </span>
                </div>

                <div className="ocv-winner-sub">
                  <div className="ocv-engine-dots">
                    {comp.engines.map((eng) => (
                      <span
                        key={eng}
                        className="ocv-engine-mini-icon"
                        title={RESEARCH_ENGINE_NAMES[eng]}
                      >
                        <ResearchEngineIcon engine={eng} />
                      </span>
                    ))}
                  </div>
                  {comp.missedByYouCount > 0 && (
                    <span className="ocv-gap-note">
                      {isEn
                        ? `Beats you on ${plural('en', comp.missedByYouCount, {
                            one: '{n} missed prompt',
                            other: '{n} missed prompts',
                          })}`
                        : `在你未命中的 ${comp.missedByYouCount} 题中出现`}
                    </span>
                  )}
                </div>

                {comp.samplePages.length > 0 && (
                  <ul className="ocv-sample-pages" data-i18n-skip="">
                    {comp.samplePages.slice(0, 2).map((page) => (
                      <li key={page.url}>
                        <a href={page.url} target="_blank" rel="noreferrer">
                          <span>{page.title}</span>
                          <ExternalLink size={11} />
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            ))}
          </div>
        </section>
      )}

      {/* Subtle on-demand escape hatch for users who want to spot-check raw prompt answers */}
      <footer className="ocv-footer-note">
        <span>
          {isEn
            ? 'Want to spot-check individual AI answer transcripts?'
            : '想按需抽查单道题的 AI 回答原文？'}
        </span>
        <button
          type="button"
          className="ocv-inline-btn"
          onClick={onOpenQuestions}
        >
          {isEn ? `Inspect in ${t('term.buyerQuestions')}` : `前往「${t('term.buyerQuestions')}」抽查`}
          <ArrowRight size={13} />
        </button>
      </footer>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Loader2,
  Sparkles,
} from 'lucide-react';
import type {
  CompetitorCandidate,
  CompetitorCandidates,
  CompetitorComparison,
} from '@/lib/geo/competitor-types';
import type { ResearchEngine } from '@/lib/geo/research-types';
import { RESEARCH_ENGINE_NAMES } from '@/lib/geo/research-engines';
import CompetitorPerformance from './CompetitorPerformance';
import OverviewCompetitorCard from './OverviewCompetitorCard';
import CompetitorGapJourney from './CompetitorGapJourney';
import './competitor-experience.css';

type Props = {
  data: CompetitorCandidates;
  comparison?: CompetitorComparison;
  presentation: 'overview' | 'workspace';
  language: 'zh' | 'en';
  engine: ResearchEngine | 'all';
  analyzing: boolean;
  analysisError: string;
  readError?: boolean;
  pending: string | null;
  onAnalyze: () => void;
  onPreview: (candidate: CompetitorCandidate) => void;
  onSelect: (candidate: CompetitorCandidate) => void;
  onOpen?: () => void;
};

const analysisPhases = [
  { id: 'preparing', label: '整理搜索依据' },
  { id: 'generating', label: '生成竞品推荐' },
  { id: 'validating', label: '核对推荐依据' },
  { id: 'saving', label: '保存推荐结果' },
] as const;

function AnalysisProgress({
  analysis,
  compact = false,
}: {
  analysis: CompetitorCandidates['analysis'];
  compact?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const started = analysis.startedAt ? Date.parse(analysis.startedAt) : NaN;
  const elapsed = Number.isFinite(started)
    ? Math.max(0, Math.floor((now - started) / 1_000))
    : null;
  const phaseIndex = analysisPhases.findIndex(
    (phase) => phase.id === analysis.phase,
  );
  return (
    <div className="cx-analysis-status">
      <div className="cx-analysis-current">
        <span role="status">
          <Loader2 size={15} className="animate-spin" />
          {phaseIndex >= 0
            ? analysisPhases[phaseIndex].label
            : analysis.status === 'running'
              ? '正在分析竞品'
              : '正在提交分析'}
        </span>
        {elapsed !== null && (
          <time dateTime={analysis.startedAt}>
            已用时 {Math.floor(elapsed / 60)}:
            {String(elapsed % 60).padStart(2, '0')}
          </time>
        )}
      </div>
      {!compact && phaseIndex >= 0 && (
        <ol className="cx-analysis-steps" aria-label="分析步骤">
          {analysisPhases.map((phase, index) => (
            <li
              key={phase.id}
              className={
                index < phaseIndex
                  ? 'is-complete'
                  : index === phaseIndex
                    ? 'is-current'
                    : ''
              }
              aria-current={index === phaseIndex ? 'step' : undefined}
            >
              {index < phaseIndex ? (
                <Check size={12} />
              ) : (
                <span>{index + 1}</span>
              )}
              {phase.label}
            </li>
          ))}
        </ol>
      )}
      {!compact &&
        (analysis.candidateCount !== undefined ||
          analysis.evidenceCount !== undefined) && (
          <p className="cx-analysis-counts">
            {[
              analysis.candidateCount !== undefined
                ? `${analysis.candidateCount} 个候选`
                : '',
              analysis.evidenceCount !== undefined
                ? `${analysis.evidenceCount} 条证据摘录`
                : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
      {!compact && (
        <p className="cx-analysis-note">
          {elapsed !== null && elapsed >= 60 ? '本次分析等待较久。' : ''}
          您可以离开此页，完成后结果会自动保存。
        </p>
      )}
    </div>
  );
}

function analysisDate(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  return new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function CompetitorExperience({
  data,
  comparison,
  presentation,
  language,
  engine,
  analyzing,
  analysisError,
  readError = false,
  pending,
  onAnalyze,
  onPreview,
  onSelect,
  onOpen,
}: Props) {
  const [changingTarget, setChangingTarget] = useState<string | null>(null);
  const isOverview = presentation === 'overview';
  const selectedCandidate = data.selectedCandidate;
  const target = data.target;
  const candidateId = selectedCandidate?.id || data.selection?.candidateId;
  const targetKey = `${target?.updatedAt || ''}:${candidateId || ''}`;
  const changing = changingTarget === targetKey;
  const recommendations = data.candidates.filter(
    (item) =>
      item.analysis?.status === 'ready' && item.analysis.recommended !== false,
  );
  const rankingMatchesScope =
    data.ranking?.scope.language === language &&
    data.ranking.scope.engine === engine;
  const analysisFailed =
    !analyzing &&
    data.analysis?.status !== 'running' &&
    (!!analysisError || data.analysis?.status === 'failed');
  const analysisRunning =
    !readError &&
    !analysisFailed &&
    (analyzing || data.analysis?.status === 'running');
  const needsAnalysis =
    data.analysis?.status === 'pending' || data.analysis?.stale;
  const showingPrevious = !!data.analysis?.stale;
  const showRecommendations = !target || changing;
  const analysisStatus = (
    <>
      {(showingPrevious ||
        (!analysisRunning && !analysisFailed && needsAnalysis)) && (
        <div className="cx-analysis-refresh">
          <p>
            {showingPrevious
              ? `显示上次分析${analysisDate(data.analysis.generatedAt) ? ` · ${analysisDate(data.analysis.generatedAt)}` : ''}`
              : '已有搜索依据，可以生成竞品推荐。'}
          </p>
          {!analysisRunning && !analysisFailed && !readError && (
            <button type="button" className="cc-button" onClick={onAnalyze}>
              {showingPrevious ? '更新推荐' : '生成推荐'}
              <ArrowRight size={13} />
            </button>
          )}
        </div>
      )}
      {analysisRunning && (
        <AnalysisProgress analysis={data.analysis} compact={isOverview} />
      )}
      {analysisFailed && (
        <div className="cx-analysis-error" role="alert">
          <p>
            竞品分析未完成：
            {analysisError || data.analysis?.error || '请重试。'}
          </p>
          {data.analysis?.status !== 'running' && !readError && (
            <button type="button" className="cc-button" onClick={onAnalyze}>
              重试分析
            </button>
          )}
        </div>
      )}
    </>
  );
  if (isOverview)
    return (
      <OverviewCompetitorCard
        data={data}
        comparison={comparison}
        candidate={recommendations[0]}
        language={language}
        engine={engine}
        pending={pending}
        status={analysisStatus}
        onSelect={onSelect}
        onOpen={onOpen}
      />
    );

  function card(candidate: CompetitorCandidate, primary: boolean) {
    const evidence = rankingMatchesScope
      ? candidate.recommendation?.evidence
      : undefined;
    const actions = (
      <div className="cx-card-actions">
        <button
          type="button"
          className={`cc-button${primary ? ' primary' : ''}`}
          disabled={!!pending || candidate.id === candidateId}
          onClick={() => onSelect(candidate)}
        >
          {pending === candidate.id
            ? '正在保存…'
            : candidate.id === candidateId
              ? '当前参照竞品'
              : '以它为参照'}
          <ArrowRight size={13} />
        </button>
        <button
          type="button"
          className="cx-text-button"
          onClick={() => onPreview(candidate)}
        >
          查看依据
          <ArrowUpRight size={12} />
        </button>
      </div>
    );
    return (
      <div className={`cx-recommendation-body${primary ? ' is-primary' : ''}`}>
        {primary && (
          <span className="cx-recommended">
            <Sparkles size={12} />
            推荐参照
          </span>
        )}
        {primary && (
          <div className="cx-candidate-heading">
            <h3>{candidate.name}</h3>
            {actions}
          </div>
        )}
        <p className="cx-description">
          {candidate.analysis?.description || candidate.description}
        </p>
        {evidence && (
          <p className="cx-reason">
            <strong>推荐依据</strong>
            {RESEARCH_ENGINE_NAMES[evidence.engine]} 在「{evidence.question}
            」的回答中提到了它。
          </p>
        )}
        <CompetitorPerformance
          performance={candidate.performance}
          ownName={comparison?.own.name}
          targetName={candidate.name}
          language={language}
          engine={engine}
          verifiedOnly
        />
        {!primary && actions}
      </div>
    );
  }
  return (
    <section
      className={`cx-experience is-${presentation}${showRecommendations ? ' is-choosing' : ' has-target'}`}
      aria-label={target ? '参照竞品差距分析' : '选择参照竞品'}
    >
      <header className="cx-heading">
        <div>
          <h2>
            {showRecommendations
              ? target
                ? '更换参照竞品'
                : '是否选择您的参照竞品？'
              : `与 ${target?.name} 的差距`}
          </h2>
        </div>
        {target && (
          <button
            type="button"
            className="cx-text-button"
            onClick={() => setChangingTarget(changing ? null : targetKey)}
          >
            {changing ? '返回差距分析' : '换一个参照'}
            <ArrowRight size={13} />
          </button>
        )}
      </header>
      {showRecommendations && analysisStatus}
      {showRecommendations ? (
        <>
          {!recommendations.length && data.analysis?.summary && (
            <p className="cx-summary" aria-label="AI 推荐总结">
              {data.analysis.summary}
            </p>
          )}
          {!analysisRunning &&
            !analysisFailed &&
            !needsAnalysis &&
            !recommendations.length && (
              <p className="cx-empty">
                当前搜索依据还不足以推荐参照竞品。完成更多问题搜索后可重新分析。
              </p>
            )}
          {!!recommendations.length && (
            <div
              className={`cx-recommendations${recommendations.length === 1 ? ' has-one' : ''}`}
            >
              <article className="cx-primary-card">
                {card(recommendations[0], true)}
              </article>
              {recommendations.length > 1 && (
                <div className="cx-alternatives">
                  {recommendations.slice(1).map((candidate, index) => (
                    <details className="cx-alternative" key={candidate.id}>
                      <summary>
                        <span>
                          <small>0{index + 2}</small>
                          <strong>{candidate.name}</strong>
                        </span>
                        <span>
                          了解
                          <ChevronDown size={13} />
                        </span>
                      </summary>
                      {card(candidate, false)}
                    </details>
                  ))}
                </div>
              )}
            </div>
          )}
          {isOverview && onOpen && (
            <button
              type="button"
              className="cx-text-button cx-open"
              onClick={onOpen}
            >
              查看推荐详情与依据
              <ArrowRight size={13} />
            </button>
          )}
        </>
      ) : (
        <>
          <CompetitorGapJourney
            data={data}
            comparison={comparison}
            language={language}
            engine={engine}
            onPreview={onPreview}
          />
          <details className="cx-learning cx-analysis-details">
            <summary>
              参照介绍与分析记录 <ChevronDown size={13} />
            </summary>
            {selectedCandidate?.analysis?.description && (
              <p>{selectedCandidate.analysis.description}</p>
            )}
            {!!selectedCandidate?.analysis?.strengths.length && (
              <ul>
                {selectedCandidate.analysis.strengths.map((strength, index) => (
                  <li key={index}>{strength}</li>
                ))}
              </ul>
            )}
            {!!selectedCandidate?.analysis?.limitations.length && (
              <details className="cx-learning">
                <summary>
                  分析边界 <ChevronDown size={12} />
                </summary>
                <ul>
                  {selectedCandidate.analysis.limitations.map(
                    (limitation, index) => (
                      <li key={index}>{limitation}</li>
                    ),
                  )}
                </ul>
              </details>
            )}
            {analysisStatus}
          </details>
        </>
      )}
    </section>
  );
}

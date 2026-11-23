'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { resolveProjectTargetLanguage } from '@/lib/geo/i18n';
import type {
  ResearchBatch,
  ResearchEngine,
  ResearchQuestion,
  ResearchSource,
} from '@/lib/geo/research-types';
import { extractTopCompetitorLeaders } from '@/lib/geo/competitor-leaders';
import {
  extractOverviewGapSources,
  getResearchMetrics,
  getResearchRows,
  isBrandPrompt,
  type ResearchFilter,
  type ResearchRow,
} from '@/lib/geo/research-view';
import {
  auditRows,
  isAiAnswerRow,
  summarizeMetric,
} from '@/lib/geo/overview-metrics';
import {
  CONSUMER_RESEARCH_ENGINES,
  getBatchResearchEngines,
  RESEARCH_ENGINES,
} from '@/lib/geo/research-engines';
import type { GeoProject } from '@/lib/geo/types';
import CompetitorCandidates from './CompetitorCandidates';
import { useUiLanguage } from './UiLanguageContext';
import './project-overview.css';
import { useBrowserCollect } from './project-overview/useBrowserCollect';
import {
  DEFAULT_VISIBLE_QUESTIONS,
  type FocusFilter,
  formatDirectMetric,
  overviewObservationDates,
  pct,
  unavailableMetric,
} from './project-overview/overview-format';
import { buildSituationVerdict } from './project-overview/situation-verdict';
import { OverviewCollectStatus } from './project-overview/OverviewCollectStatus';
import { OverviewEmptyState } from './project-overview/OverviewEmptyState';
import { OverviewTopbar } from './project-overview/OverviewTopbar';
import { OverviewEarlyRetest } from './project-overview/OverviewEarlyRetest';
import { OverviewInsightsHero } from './project-overview/OverviewInsightsHero';
import { OverviewMentionCard } from './project-overview/OverviewMentionCard';
import { OverviewCitationCard } from './project-overview/OverviewCitationCard';
import { OverviewPlatformCard } from './project-overview/OverviewPlatformCard';
import { OverviewQuestionFilters } from './project-overview/OverviewQuestionFilters';
import { OverviewQuestionMatrix } from './project-overview/OverviewQuestionMatrix';
import { OverviewGapSources } from './project-overview/OverviewGapSources';

// Kept so existing imports from './ProjectOverview' keep working.
export { OverviewAudit, OverviewMention } from './project-overview/OverviewAudit';
export { overviewObservationDates } from './project-overview/overview-format';

type Props = {
  projectOptimization?: ReactNode;
  activeOptimizationRunId?: string | null;
  latestShippedAt?: string | null;
  project?: Pick<GeoProject, 'siteUrl' | 'repositoryUrl' | 'targetLanguage'> & {
    name?: string;
  };
  previewOnly?: boolean;
  previewComparison?: ReactNode;
  batch: ResearchBatch;
  filters: ResearchFilter;
  workflow: ReactNode;
  onFilters: (patch: Partial<ResearchFilter>) => void;
  onQuestion: (
    question: ResearchQuestion,
    engine?: ResearchRow['engine'],
  ) => void;
  onSource: (source: ResearchSource, rows: ResearchRow[]) => void;
  onEvidence: (path: string) => void;
  onCompetitor: () => void;
  onQuestions: () => void;
  onRefresh?: () => void;
  onAssets?: () => void;
  onPlan?: (
    question?: ResearchQuestion,
    language?: 'zh' | 'en',
    engine?: ResearchEngine,
  ) => Promise<void> | void;
};

export default function ProjectOverview({
  projectOptimization,
  activeOptimizationRunId,
  latestShippedAt,
  project,
  previewOnly = false,
  previewComparison,
  batch,
  filters,
  onFilters,
  onQuestion,
  onCompetitor,
  onQuestions,
  onRefresh,
  onPlan,
}: Props) {
  const { uiLanguage, t } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const [copiedCmd, setCopiedCmd] = useState(false);
  const {
    collectJob,
    startingCollect,
    collectActionError,
    startCollect,
    stopCollect,
    resumeCollect,
  } = useBrowserCollect({
    projectId: batch.projectId,
    previewOnly,
    activeOptimizationRunId,
    onRefresh,
  });
  const hasLangObs = (lang: 'zh' | 'en') =>
    batch.questions.some((q) =>
      q.observations.some((obs) => obs.language === lang),
    );
  const activeLanguage: 'zh' | 'en' = hasLangObs(filters.language)
    ? filters.language
    : resolveProjectTargetLanguage(project, batch);

  const scopeKey = `${batch.projectId}:${activeLanguage}:${filters.engine}`;
  const [uiState, setUiState] = useState<{
    scope: string;
    focus: FocusFilter;
    expandedQuestions: boolean;
  }>({
    scope: scopeKey,
    focus: 'all',
    expandedQuestions: false,
  });
  const [earlyRetestHours, setEarlyRetestHours] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState<number | null>(null);
  const questionSectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    // Set after mount so server and client render the same markup.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNowMs(Date.now());
  }, []);

  const inScope = uiState.scope === scopeKey;
  const focus: FocusFilter = inScope ? uiState.focus : 'all';
  const expandedQuestions = inScope ? uiState.expandedQuestions : false;

  const patchUiState = (
    updater: (curr: {
      focus: FocusFilter;
      expandedQuestions: boolean;
    }) => Partial<{
      focus: FocusFilter;
      expandedQuestions: boolean;
    }>,
  ) => {
    setUiState((prev) => {
      const curr =
        prev.scope === scopeKey
          ? prev
          : {
              focus: 'all' as FocusFilter,
              expandedQuestions: false,
            };
      return {
        scope: scopeKey,
        focus: curr.focus,
        expandedQuestions: curr.expandedQuestions,
        ...updater(curr),
      };
    });
  };

  const setFocus = (next: FocusFilter | ((curr: FocusFilter) => FocusFilter)) =>
    patchUiState((curr) => ({
      focus: typeof next === 'function' ? next(curr.focus) : next,
    }));

  const setExpandedQuestions = (
    next: boolean | ((curr: boolean) => boolean),
  ) =>
    patchUiState((curr) => ({
      expandedQuestions:
        typeof next === 'function' ? next(curr.expandedQuestions) : next,
    }));

  const availableEngines = RESEARCH_ENGINES.filter((engine) =>
    batch.questions.some((q) =>
      q.observations.some((obs) => obs.engine === engine),
    ),
  );

  const selectedEngine: ResearchFilter['engine'] =
    filters.engine !== 'all' && availableEngines.includes(filters.engine)
      ? filters.engine
      : 'all';
  const allPlatforms = selectedEngine === 'all';
  const displayedEngines = allPlatforms
    ? availableEngines
    : [selectedEngine as ResearchEngine];

  const activeBatchEngines = getBatchResearchEngines(batch);
  const matrixEngines: ResearchEngine[] = allPlatforms
    ? activeBatchEngines
    : [selectedEngine as ResearchEngine];

  const allEngineRows = auditRows(
    batch,
    RESEARCH_ENGINES.flatMap((engine) =>
      getResearchRows(batch, {
        ...filters,
        language: activeLanguage,
        kind: 'all',
        engine,
        result: 'all',
      }),
    ),
    batch.answerAudits ?? [],
  );

  const rows = allEngineRows.filter((row) =>
    displayedEngines.includes(row.engine),
  );

  const platformStats = availableEngines.map((engine) => {
    const engineRows = allEngineRows.filter((r) => r.engine === engine);
    const measured = engineRows.filter((r) => r.observation);
    const ai = (measured.length ? measured : engineRows).some(isAiAnswerRow);
    const official = getResearchMetrics(engineRows);
    const mentionMetric =
      batch.overviewMetrics?.[`${activeLanguage}:${engine}`]?.mention ??
      summarizeMetric(engineRows, 'mention');
    const yesCount = ai ? mentionMetric.yes : official.found;
    const totalCount = ai ? mentionMetric.completed : official.completed;
    const directRate =
      totalCount > 0 && (!ai || mentionMetric.unknown === 0)
        ? Number(((yesCount / totalCount) * 100).toFixed(1))
        : null;

    return {
      engine,
      ai,
      yesCount,
      totalCount,
      rate: directRate,
      unknownCount: ai ? mentionMetric.unknown : 0,
    };
  });

  const displayedAi = rows
    .filter((r) => r.observation)
    .some(isAiAnswerRow);
  const sourceOnly = !allPlatforms && !displayedAi;
  const officialMetrics = getResearchMetrics(rows);
  const scopedMetrics =
    batch.overviewMetrics?.[`${activeLanguage}:${selectedEngine}`];
  const mention = scopedMetrics?.mention ?? unavailableMetric;
  const citation = scopedMetrics?.citation ?? unavailableMetric;

  const allQuestions = batch.questions.filter((q) =>
    rows.some((r) => r.question.id === q.id),
  );

  const questionHasMiss = (q: ResearchQuestion) => {
    const matching = rows.filter((r) => r.question.id === q.id && r.observation);
    if (!matching.length) return false;
    return matching.every((r) =>
      isAiAnswerRow(r)
        ? r.audit?.mention === 'no'
        : r.observation?.status === 'not_observed',
    );
  };

  const questionHasMention = (q: ResearchQuestion) => {
    const matching = rows.filter((r) => r.question.id === q.id && r.observation);
    return matching.some((r) =>
      isAiAnswerRow(r)
        ? r.audit?.mention === 'yes'
        : r.observation?.status === 'found',
    );
  };

  const questionHasCitation = (q: ResearchQuestion) =>
    rows.some(
      (r) =>
        r.question.id === q.id &&
        isAiAnswerRow(r) &&
        r.audit?.citation === 'yes',
    );

  const questionHasUncertain = (q: ResearchQuestion) =>
    rows.some(
      (r) =>
        r.question.id === q.id &&
        r.observation &&
        isAiAnswerRow(r) &&
        (!r.audit ||
          r.audit.mention === 'unknown' ||
          r.audit.citation === 'unknown'),
    );

  const splitCounts = (subset: ResearchRow[]) => {
    if (sourceOnly) {
      const m = getResearchMetrics(subset);
      return { yes: m.found, total: m.completed };
    }
    const m = summarizeMetric(subset, 'mention');
    return { yes: m.yes, total: m.completed };
  };
  const brandLabel = project?.name?.trim() || (isEn ? 'your brand' : '品牌名');
  const discoverySplit = splitCounts(
    rows.filter((r) => !isBrandPrompt(r.question, project?.name)),
  );
  const brandSplit = splitCounts(
    rows.filter((r) => isBrandPrompt(r.question, project?.name)),
  );
  const brandQuestionCount = allQuestions.filter((q) =>
    isBrandPrompt(q, project?.name),
  ).length;

  const missedCount = allQuestions.filter(questionHasMiss).length;
  const mentionedCount = allQuestions.filter(questionHasMention).length;
  const citedCount = allQuestions.filter(questionHasCitation).length;

  const filteredQuestions = allQuestions
    .filter((q) => {
      if (focus === 'missed') return questionHasMiss(q);
      if (focus === 'mentioned') return questionHasMention(q);
      if (focus === 'cited') return questionHasCitation(q);
      if (focus === 'uncertain') return questionHasUncertain(q);
      if (focus === 'brand') return isBrandPrompt(q, project?.name);
      return true;
    })
    .sort((a, b) => Number(questionHasMiss(b)) - Number(questionHasMiss(a)));

  const shouldCollapse =
    focus === 'all' &&
    !expandedQuestions &&
    filteredQuestions.length > DEFAULT_VISIBLE_QUESTIONS;
  const displayedQuestions = shouldCollapse
    ? filteredQuestions.slice(0, DEFAULT_VISIBLE_QUESTIONS)
    : filteredQuestions;
  const hiddenQuestionCount =
    filteredQuestions.length - DEFAULT_VISIBLE_QUESTIONS;

  const jumpFocus = (next: FocusFilter) => {
    setFocus((curr) => (curr === next ? 'all' : next));
    questionSectionRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
    });
  };

  const jumpSources = () => {
    jumpFocus(
      citation.yes > 0
        ? 'cited'
        : citation.unknown > 0
          ? 'uncertain'
          : 'missed',
    );
  };

  const collectCommand = `npm run collect -- --project ${batch.projectId}`;
  if (!availableEngines.length) {
    const langLabel = t(
      activeLanguage === 'en'
        ? 'overview.targetLangEnLabel'
        : 'overview.targetLangZhLabel',
    );
    const copyCollectCommand = () => {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        void navigator.clipboard.writeText(collectCommand).then(() => {
          setCopiedCmd(true);
          setTimeout(() => setCopiedCmd(false), 2400);
        });
      }
    };
    return (
      <OverviewEmptyState
        batch={batch}
        langLabel={langLabel}
        onQuestions={onQuestions}
        collectActionError={collectActionError}
        collectJob={collectJob}
        stopCollect={stopCollect}
        startingCollect={startingCollect}
        resumeCollect={resumeCollect}
        startCollect={startCollect}
        collectCommand={collectCommand}
        copyCollectCommand={copyCollectCommand}
        copiedCmd={copiedCmd}
        project={project}
        activeLanguage={activeLanguage}
      />
    );
  }

  const dateRange = overviewObservationDates(rows, isEn);

  const shippedMs = latestShippedAt ? Date.parse(latestShippedAt) : NaN;
  const hrsSinceShip =
    nowMs !== null && Number.isFinite(shippedMs)
      ? Math.max(0, (nowMs - shippedMs) / 3_600_000)
      : Infinity;

  const isColdZeroStage =
    !sourceOnly &&
    mention.completed > 0 &&
    mention.yes === 0 &&
    citation.yes === 0 &&
    mention.unknown === 0 &&
    citation.unknown === 0;
  const topCompetitorLeaders = extractTopCompetitorLeaders(batch, project, {
    language: activeLanguage,
    engine: selectedEngine,
    limit: 2,
  });
  const overviewGapSources = extractOverviewGapSources(batch, project, {
    engine: selectedEngine,
    language: activeLanguage,
    limit: 5,
  });

  // Deterministic 0-cost Peec Insights-style situation verdict (actual rival products, never youtube/reddit)
  const topLeaderNames = topCompetitorLeaders.map((w) => w.label).join(' & ');
  const measuredPlatforms = platformStats.filter((p) => p.rate !== null);
  const sortedByRate = [...measuredPlatforms].sort(
    (a, b) => (b.rate ?? 0) - (a.rate ?? 0),
  );
  const strongestPlatform =
    sortedByRate.length >= 2 &&
    (sortedByRate[0].rate ?? 0) > (sortedByRate[sortedByRate.length - 1].rate ?? 0)
      ? sortedByRate[0]
      : null;
  const weakestPlatform =
    strongestPlatform ? sortedByRate[sortedByRate.length - 1] : null;

  const situationVerdict = buildSituationVerdict({
    sourceOnly,
    isEn,
    officialMetrics,
    mention,
    topLeaderNames,
    brandSplit,
    discoverySplit,
    brandLabel,
    strongestPlatform,
    weakestPlatform,
    citation,
  });

  const unauditedAiCount = rows.filter(
    (r) => r.observation && isAiAnswerRow(r) && !r.audit,
  ).length;
  const couldNotVerifyLabel = t('term.couldNotVerify');

  const mentionDisplay = sourceOnly
    ? {
        primary: pct(officialMetrics.rate),
        qualifier: undefined,
        subline: isEn
          ? `${officialMetrics.found} of ${officialMetrics.completed} search results included your site`
          : `${officialMetrics.completed} 条搜索记录中，${officialMetrics.found} 条找到官网`,
        ringCenter: `${officialMetrics.found}/${officialMetrics.completed}`,
      }
    : formatDirectMetric(mention, 'mention', isEn, {
        unauditedCount: unauditedAiCount,
        couldNotVerifyLabel,
      });

  const citationDisplay = formatDirectMetric(citation, 'citation', isEn, {
    unauditedCount: unauditedAiCount,
    couldNotVerifyLabel,
  });

  const unmeasuredConsumerEngines = CONSUMER_RESEARCH_ENGINES.filter(
    (e) => !availableEngines.includes(e),
  );

  return (
    <div className="pov-shell">
      {collectActionError && (
        <div className="pov-collect-status is-error" role="alert">
          <div className="pov-collect-status-main">
            <AlertTriangle size={16} />
            <div>
              <strong>{collectActionError}</strong>
            </div>
          </div>
        </div>
      )}
      <OverviewCollectStatus
        collectJob={collectJob}
        stopCollect={stopCollect}
        startingCollect={startingCollect}
        resumeCollect={resumeCollect}
      />
      {/* Top Bar */}
      <OverviewTopbar
        allQuestions={allQuestions}
        availableEngines={availableEngines}
        dateRange={dateRange}
        previewOnly={previewOnly}
        startingCollect={startingCollect}
        collectJob={collectJob}
        selectedEngine={selectedEngine}
        hrsSinceShip={hrsSinceShip}
        setEarlyRetestHours={setEarlyRetestHours}
        startCollect={startCollect}
        activeOptimizationRunId={activeOptimizationRunId}
        allPlatforms={allPlatforms}
        onFilters={onFilters}
      />

      {earlyRetestHours !== null && (
        <OverviewEarlyRetest
          earlyRetestHours={earlyRetestHours}
          setEarlyRetestHours={setEarlyRetestHours}
          startCollect={startCollect}
          selectedEngine={selectedEngine}
          activeOptimizationRunId={activeOptimizationRunId}
        />
      )}

      {/* Layer 1: Peec Insights-Style 0-Cost Situation Verdict */}
      <OverviewInsightsHero
        batch={batch}
        project={project}
        activeLanguage={activeLanguage}
        situationVerdict={situationVerdict}
        mention={mention}
        sourceOnly={sourceOnly}
        officialMetrics={officialMetrics}
        citation={citation}
        discoverySplit={discoverySplit}
        brandSplit={brandSplit}
        focus={focus}
        jumpFocus={jumpFocus}
        brandLabel={brandLabel}
        platformStats={platformStats}
        selectedEngine={selectedEngine}
        onFilters={onFilters}
        onCompetitor={onCompetitor}
      />

      {isColdZeroStage ? (
        <>
          {/* Layer 2: Crisp Monochrome Next Move Bar */}
          {projectOptimization && (
            <div className="pov-optimization-slot">{projectOptimization}</div>
          )}

          {previewOnly && previewComparison && (
            <div className="pov-competitor-slot">{previewComparison}</div>
          )}
          {!previewOnly && (
            <div className="pov-competitor-slot">
              <CompetitorCandidates
                key={`${batch.projectId}:${batch.id}`}
                projectId={batch.projectId}
                batchId={batch.id}
                revision={batch.updatedAt || batch.date}
                language={activeLanguage}
                engine={selectedEngine}
                presentation="overview"
                onOpen={onCompetitor}
              />
            </div>
          )}
        </>
      ) : (
        <>
          {/* Row 1: 3-Card Bento Scoreboard with Symmetric Donut Rings */}
      <section className="pov-bento" aria-label={isEn ? 'Key performance' : '核心表现'}>
        {/* Card 1: AI Mention */}
        <OverviewMentionCard
          focus={focus}
          jumpFocus={jumpFocus}
          sourceOnly={sourceOnly}
          officialMetrics={officialMetrics}
          mention={mention}
          mentionDisplay={mentionDisplay}
          brandSplit={brandSplit}
          discoverySplit={discoverySplit}
          brandLabel={brandLabel}
        />

        {/* Card 2: Official Citation */}
        <OverviewCitationCard
          focus={focus}
          sourceOnly={sourceOnly}
          jumpSources={jumpSources}
          citation={citation}
          citationDisplay={citationDisplay}
        />

        {/* Card 3: Platform Breakdown with Colorful Brand Icons */}
        <OverviewPlatformCard
          onCompetitor={onCompetitor}
          platformStats={platformStats}
          selectedEngine={selectedEngine}
          onFilters={onFilters}
          unmeasuredConsumerEngines={unmeasuredConsumerEngines}
          startingCollect={startingCollect}
          collectJob={collectJob}
          startCollect={startCollect}
        />
      </section>

      {/* Restored Competitor Reference Card */}
      {previewOnly && previewComparison && (
        <div className="pov-competitor-slot">{previewComparison}</div>
      )}
      {!previewOnly && (
        <div className="pov-competitor-slot">
          <CompetitorCandidates
            key={`${batch.projectId}:${batch.id}`}
            projectId={batch.projectId}
            batchId={batch.id}
            revision={batch.updatedAt || batch.date}
            language={activeLanguage}
            engine={selectedEngine}
            presentation="overview"
            onOpen={onCompetitor}
          />
        </div>
      )}

      {/* Row 2: Human-Guided Next-Step Optimization Card */}
      {projectOptimization && (
        <div className="pov-optimization-slot">{projectOptimization}</div>
      )}
        </>
      )}

      {/* Layer 3: Top-3 Collapsible Priority Questions + Colorful Platform Tile Matrix (Above the Fold) */}
      <section
        className="pov-questions"
        ref={questionSectionRef}
        aria-label={t('overview.buyerQuestions')}
      >
        <OverviewQuestionFilters
          focus={focus}
          setFocus={setFocus}
          allQuestions={allQuestions}
          missedCount={missedCount}
          mentionedCount={mentionedCount}
          sourceOnly={sourceOnly}
          citedCount={citedCount}
          brandQuestionCount={brandQuestionCount}
          brandLabel={brandLabel}
          onQuestions={onQuestions}
        />

        {displayedQuestions.length === 0 ? (
          <div className="pov-filter-empty">
            <span>{t('overview.filterEmpty')}</span>
            <button type="button" onClick={() => setFocus('all')}>
              {t('overview.filterShowAll')}
            </button>
          </div>
        ) : (
          <>
            <OverviewQuestionMatrix
              displayedQuestions={displayedQuestions}
              project={project}
              matrixEngines={matrixEngines}
              allEngineRows={allEngineRows}
              couldNotVerifyLabel={couldNotVerifyLabel}
              activeLanguage={activeLanguage}
              onQuestion={onQuestion}
              allPlatforms={allPlatforms}
              selectedEngine={selectedEngine}
            />

            {focus === 'all' &&
              filteredQuestions.length > DEFAULT_VISIBLE_QUESTIONS && (
                <button
                  type="button"
                  className="pov-expand-bar"
                  onClick={() => setExpandedQuestions((v) => !v)}
                >
                  {expandedQuestions ? (
                    <>
                      {t('overview.collapseQuestions', {
                        count: DEFAULT_VISIBLE_QUESTIONS,
                      })}
                      <ChevronUp size={15} />
                    </>
                  ) : (
                    <>
                      {t('overview.expandRemaining', {
                        hidden: hiddenQuestionCount,
                        total: filteredQuestions.length,
                      })}
                      <ChevronDown size={15} />
                    </>
                  )}
                </button>
              )}
          </>
        )}
      </section>

      {/* Layer 4: External Pages AI Cites Without You (Plain-Language Listing Opportunities) */}
      {overviewGapSources.length > 0 && (
        <OverviewGapSources
          onPlan={onPlan}
          overviewGapSources={overviewGapSources}
        />
      )}
    </div>
  );
}

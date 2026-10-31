'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowRight,
  ChevronDown,
  ExternalLink,
  MessageCircle,
  Search,
  Layers3,
  TrendingUp,
  Compass,
} from 'lucide-react';
import { SiGoogle, SiOpenai } from '@icons-pack/react-simple-icons';
import type {
  ResearchBatch,
  ResearchQuestion,
  ResearchSource,
  ResearchEngine,
} from '@/lib/geo/research-types';
import {
  getResearchRows,
  getResearchMetrics,
  type ResearchFilter,
  type ResearchRow,
} from '@/lib/geo/research-view';
import {
  auditRows,
  isAiAnswerRow,
  summarizeMetric,
  type MetricSummary,
} from '@/lib/geo/overview-metrics';
import {
  RESEARCH_ENGINES,
  RESEARCH_ENGINE_NAMES,
  isConsumerResearchEngine,
} from '@/lib/geo/research-engines';
import CompetitorCandidates from './CompetitorCandidates';
import OverviewPriorityQuestions from './OverviewPriorityQuestions';
import './project-overview.css';

const unavailableMetric: MetricSummary = {
  rate: null,
  minimumRate: null,
  yes: 0,
  no: 0,
  unknown: 0,
  completed: 0,
  unmeasured: 0,
  questions: 0,
};
export function overviewObservationDates(rows: ResearchRow[]): string {
  const dates = [
    ...new Set(
      rows.flatMap((row) => {
        const date =
          row.observation?.recordedAt.match(/\d{4}-\d{2}-\d{2}/)?.[0];
        return date ? [date] : [];
      }),
    ),
  ].sort();
  return !dates.length
    ? '尚无观测日期'
    : dates.length === 1
      ? dates[0]
      : `${dates[0]} — ${dates[dates.length - 1]}`;
}
const pct = (value: number | null) =>
  value === null ? '—' : `${Number(value.toFixed(1))}%`;
const verdict = { yes: '已提及', no: '未提及', unknown: '待核实' };
const platformNames: Record<ResearchEngine, string> = {
  chatgpt: 'ChatGPT',
  google: 'Google',
  deepseek: 'DeepSeek',
  qwen: '千问',
  doubao: '豆包',
};

export function OverviewMention({
  batch,
  row,
}: {
  batch: ResearchBatch;
  row: ResearchRow;
}) {
  const audit = auditRows(batch, [row], batch.answerAudits ?? [])[0]?.audit;
  return (
    <span
      className={`pov-status ${audit?.mention === 'yes' ? 'positive' : ''}`}
    >
      {!row.observation ? '未测' : verdict[audit?.mention ?? 'unknown']}
    </span>
  );
}

export function OverviewAudit({
  batch,
  row,
}: {
  batch: ResearchBatch;
  row: ResearchRow;
}) {
  const audit = auditRows(batch, [row], batch.answerAudits ?? [])[0]?.audit;
  if (!row.observation || !isAiAnswerRow(row)) return null;
  return (
    <div className="pov-audit-detail">
      <div>
        <strong>正文提及 · {verdict[audit?.mention ?? 'unknown']}</strong>
        <p>{audit?.mentionEvidence || '这条回答尚未复核。'}</p>
      </div>
      <div>
        <strong>
          官方引用 ·{' '}
          {audit?.citation === 'yes'
            ? '已确认'
            : audit?.citation === 'no'
              ? '未引用'
              : '待核实'}
        </strong>
        <p>{audit?.citationEvidence || '引用关系尚未核实。'}</p>
      </div>
    </div>
  );
}

type Props = {
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
  onPlan?: (question: ResearchQuestion, language: 'zh' | 'en', engine: ResearchEngine) => Promise<void>;
};

export default function ProjectOverview({
  previewOnly = false,
  previewComparison,
  batch,
  filters,
  workflow,
  onFilters,
  onQuestion,
  onSource,
  onEvidence,
  onCompetitor,
  onQuestions,
  onPlan,
}: Props) {
  const [allSources, setAllSources] = useState(false);
  const [focus, setFocus] = useState<
    'all' | 'missed' | 'mentioned' | 'cited' | 'uncertain'
  >('all');
  const questionArea = useRef<HTMLElement>(null);
  useEffect(() => {
    setFocus('all');
    setAllSources(false);
  }, [batch.projectId, filters.language, filters.kind, filters.engine]);

  const availableEngines = RESEARCH_ENGINES.filter((engine) =>
    batch.questions.some((question) =>
      question.observations.some(
        (observation) => observation.engine === engine,
      ),
    ),
  );
  const selectedEngine: ResearchFilter['engine'] =
    filters.engine !== 'all' && availableEngines.includes(filters.engine)
      ? filters.engine
      : 'all';
  const allPlatforms = selectedEngine === 'all';
  const currentEngine = allPlatforms ? 'chatgpt' : selectedEngine;
  const googleOnly = currentEngine === 'google';
  const apiOnly = !allPlatforms && !isConsumerResearchEngine(currentEngine);
  const displayedEngines = allPlatforms ? availableEngines : [currentEngine];
  const rows = auditRows(
    batch,
    displayedEngines.flatMap((engine) =>
      getResearchRows(batch, {
        ...filters,
        kind: 'all',
        engine,
        result: 'all',
      }),
    ),
    batch.answerAudits ?? [],
  );
  const platformResults = displayedEngines.map((engine) => {
    const platformRows = rows.filter((row) => row.engine === engine);
    const measuredRows = platformRows.filter((row) => row.observation);
    return {
      engine,
      rows: platformRows,
      ai: (measuredRows.length ? measuredRows : platformRows).some(
        isAiAnswerRow,
      ),
      official: getResearchMetrics(platformRows),
      mention:
        batch.overviewMetrics?.[`${filters.language}:${engine}`]?.mention ??
        unavailableMetric,
    };
  });
  const hasAiAnswers = platformResults.some((item) => item.ai);
  const sourceOnly = !allPlatforms && !hasAiAnswers;
  const aiPlatformLabel = allPlatforms
    ? 'AI 回答'
    : `${platformNames[currentEngine]} 回答`;
  const official = getResearchMetrics(rows);
  const metrics =
    batch.overviewMetrics?.[`${filters.language}:${selectedEngine}`];
  const mention = metrics?.mention ?? unavailableMetric;
  const citation = metrics?.citation ?? unavailableMetric;
  const allQuestions = batch.questions.filter((q) =>
    rows.some((r) => r.question.id === q.id),
  );
  const missingQuestions = allQuestions.filter((q) => {
    const matching = rows.filter((r) => r.question.id === q.id);
    if (allPlatforms) {
      const measured = matching.filter((r) => r.observation);
      return (
        measured.length > 0 &&
        measured.every((r) =>
          isAiAnswerRow(r)
            ? summarizeMetric([r], 'mention').rate === 0
            : r.observation?.status === 'not_observed',
        )
      );
    }
    return sourceOnly
      ? matching.some((r) => r.observation) &&
          matching.every((r) => r.observation?.status === 'not_observed')
      : summarizeMetric(matching, 'mention').rate === 0;
  });
  const selectedQuestions = allQuestions
    .filter((q) => {
      const matching = rows.filter((r) => r.question.id === q.id);
      if (focus === 'missed')
        return missingQuestions.some((item) => item.id === q.id);
      if (focus === 'mentioned')
        return sourceOnly
          ? matching.some((r) => r.observation?.status === 'found')
          : matching.some((r) => r.audit?.mention === 'yes');
      if (focus === 'cited')
        return matching.some((r) => r.audit?.citation === 'yes');
      if (focus === 'uncertain')
        return matching.some(
          (r) =>
            isAiAnswerRow(r) &&
            r.observation &&
            (!r.audit || r.audit.citation === 'unknown'),
        );
      return true;
    })
    .sort(
      (a, b) =>
        Number(missingQuestions.some((q) => q.id === b.id)) -
        Number(missingQuestions.some((q) => q.id === a.id)),
    );
  const sourceMap = new Map<
    string,
    { source: ResearchSource; rows: ResearchRow[] }
  >();
  for (const row of rows)
    for (const source of row.observation?.sources ?? []) {
      if (!/^https?:\/\//i.test(source.url)) continue;
      const item = sourceMap.get(source.url) ?? { source, rows: [] };
      if (!item.rows.some((existing) => existing.key === row.key))
        item.rows.push(row);
      sourceMap.set(source.url, item);
    }
  const sources = [...sourceMap.values()].sort(
    (a, b) => b.rows.length - a.rows.length,
  );
  const completed = allPlatforms
    ? official.completed
    : sourceOnly || !metrics
      ? official.completed
      : mention.completed;
  const label = '问题';
  const primaryRate = sourceOnly ? official.rate : mention.rate;
  function select(value: typeof focus) {
    setFocus(value);
    questionArea.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }

  if (!availableEngines.length)
    return (
      <div className="pov-dashboard">
        <section className="pov-lead">
          <div>
            <h2>还没有平台结果</h2>
            <p>
              当前题单有 {batch.questions.length} 个问题，完成搜索后在这里查看。
            </p>
          </div>
          <button className="rw-primary" onClick={onQuestions}>
            去问题监测 <ArrowRight size={15} />
          </button>
        </section>
      </div>
    );

  return (
    <div className="pov-dashboard">
      <div className="pov-platform-toolbar">
        <span className="pov-platform-label">平台</span>
        <div className="pov-platform-tabs" role="group" aria-label="平台">
          <button
            className="pov-platform-tab"
            aria-pressed={allPlatforms}
            onClick={() =>
              onFilters({ engine: 'all', kind: 'all', result: 'all' })
            }
          >
            <span className="pov-platform-icon" aria-hidden="true">
              <Layers3 size={16} />
            </span>
            <span>全部</span>
          </button>
          {availableEngines.map((engine) => (
            <button
              key={engine}
              className="pov-platform-tab"
              aria-pressed={selectedEngine === engine}
              onClick={() => onFilters({ engine, kind: 'all', result: 'all' })}
            >
              <span
                className="pov-platform-icon"
                data-engine={engine}
                aria-hidden="true"
              >
                {engine === 'chatgpt' ? (
                  <SiOpenai size={17} />
                ) : engine === 'google' ? (
                  <SiGoogle size={16} />
                ) : engine === 'deepseek' ? (
                  <Search size={16} />
                ) : (
                  <MessageCircle size={16} />
                )}
              </span>
              <span>{platformNames[engine]}</span>
            </button>
          ))}
        </div>
        <div className="rw-language" role="group" aria-label="问法语言">
          {(['zh', 'en'] as const).map((language) => (
            <button
              key={language}
              aria-pressed={filters.language === language}
              onClick={() =>
                onFilters({
                  language,
                  engine: selectedEngine,
                  kind: 'all',
                  result: 'all',
                })
              }
            >
              {language === 'zh' ? '中文' : 'English'}
            </button>
          ))}
        </div>
      </div>
      <section className="pov-lead">
        <div>
          <h2>
            {allPlatforms
              ? `${availableEngines.length} 个平台，${allQuestions.length} 个问题的表现`
              : !sourceOnly && !metrics
                ? '回答审核结果待读取'
                : !completed
                  ? `${platformNames[currentEngine]} 还没有${filters.language === 'zh' ? '中文' : '英文'}结果`
                  : !sourceOnly && mention.yes > 0
                    ? `${platformNames[currentEngine]} 的 ${completed} 条回答中，${mention.yes} 条提到了你`
                    : missingQuestions.length
                      ? sourceOnly
                        ? `${RESEARCH_ENGINE_NAMES[currentEngine]}：${missingQuestions.length} 个${label}未见官方来源`
                        : `${platformNames[currentEngine]} 在 ${missingQuestions.length} 个${label}的回答中未提到你`
                      : !sourceOnly && mention.unknown
                        ? '部分回答还需核实'
                        : `已测${label}${sourceOnly ? '均找到官方来源' : '均有回答提到你'}`}
          </h2>
          <p>
            {allQuestions.length} 个{label} ·{' '}
            {allPlatforms
              ? `${availableEngines.length} 个平台`
              : apiOnly
                ? RESEARCH_ENGINE_NAMES[currentEngine]
                : googleOnly
                  ? 'Google 普通网页'
                  : `${platformNames[currentEngine]} 个人账号`}{' '}
            · {completed} 条{allPlatforms ? '已保存结果' : '已测'}
            {!allPlatforms &&
              !sourceOnly &&
              metrics &&
              ` · ${mention.unknown ? `${mention.unknown} 条正文待核实` : '正文已复核'}`}
          </p>
        </div>
        {!!missingQuestions.length && (
          <button className="rw-primary" onClick={() => select('missed')}>
            查看{allPlatforms ? '未出现' : sourceOnly ? '未找到' : '未提及'}问题{' '}
            <ArrowRight size={15} />
          </button>
        )}
      </section>

      <div className="pov-metric-strip" role="region" aria-label="关键指标">
        <section className="pov-metric-card is-primary">
          <header>
            <h3>
              {sourceOnly
                ? `${platformNames[currentEngine]} 来源命中率`
                : 'AI 提及率'}
            </h3>
            {sourceOnly ? <Search size={16} /> : <MessageCircle size={16} />}
          </header>
          <div className="pov-card-gauge">
            <button
              className="pov-primary-number"
              onClick={() => select('mentioned')}
              aria-label={
                sourceOnly ? '查看找到官方来源的问题' : '查看提到我们的回答'
              }
            >
              <span
                className={`pov-water-gauge${primaryRate === null ? ' is-unknown' : ''}`}
              >
                <span
                  className={`pov-water-fill${primaryRate !== null && primaryRate > 0 && primaryRate < 100 ? ' has-waterline' : ''}`}
                  style={{ height: `${primaryRate ?? 0}%` }}
                  aria-hidden="true"
                />
                <span className="pov-water-value">{pct(primaryRate)}</span>
              </span>
            </button>
            <div className="pov-gauge-copy">
              <p>
                {sourceOnly
                  ? `${official.found} / ${official.completed} 条找到你`
                  : metrics
                    ? `${mention.yes} / ${mention.completed} 条提到你`
                    : '审核结果待读取'}
              </p>
              <p className="pov-card-note">
                {sourceOnly ? platformNames[currentEngine] : aiPlatformLabel}
              </p>
              {!sourceOnly && mention.unknown > 0 && (
                <p className="pov-card-note">{mention.unknown} 条待核实</p>
              )}
            </div>
          </div>
        </section>
        <section className="pov-metric-card">
          <header>
            <h3>自有内容引用率</h3>
            <ExternalLink size={16} />
          </header>
          <button
            className={`pov-card-value${citation.unknown && !citation.yes ? ' is-text' : ''}`}
            disabled={sourceOnly}
            onClick={() =>
              select(
                citation.yes
                  ? 'cited'
                  : citation.unknown
                    ? 'uncertain'
                    : 'cited',
              )
            }
          >
            {sourceOnly
              ? '不适用'
              : citation.unknown
                ? citation.yes
                  ? `至少 ${pct(citation.minimumRate)}`
                  : '待核实'
                : pct(citation.rate)}
            {!sourceOnly && <ArrowRight size={15} />}
          </button>
          <p className="pov-card-note">
            {sourceOnly
              ? '当前平台提供网页搜索结果'
              : metrics
                ? `${aiPlatformLabel} · ${citation.yes} / ${citation.completed} 条确认引用`
                : '审核结果待读取'}
          </p>
          {citation.unknown > 0 && (
            <button
              className="pov-text-link pov-card-note"
              onClick={() => select('uncertain')}
            >
              {citation.unknown} 条待核实
            </button>
          )}
        </section>
        <section className="pov-metric-card">
          <header>
            <h3>表现最佳</h3>
            <TrendingUp size={16} />
          </header>
          {allPlatforms ? (
            <div className="pov-card-value is-text pov-unavailable-comparison">
              尚不可比
            </div>
          ) : (
            <button
              className="pov-card-value is-text"
              onClick={() => onFilters({ engine: 'all' })}
            >
              查看全部平台 <ArrowRight size={15} />
            </button>
          )}
          <p className="pov-card-note">
            {allPlatforms
              ? '按 AI 提及率 · 同题平台对比尚未完成'
              : '单个平台不作跨平台排名'}
          </p>
        </section>
        <section className="pov-metric-card">
          <header>
            <h3>最需关注</h3>
            <Compass size={16} />
          </header>
          {allPlatforms ? (
            <div className="pov-card-value is-text pov-unavailable-comparison">
              尚不可比
            </div>
          ) : (
            <button
              className="pov-card-value is-text"
              onClick={() => onFilters({ engine: 'all' })}
            >
              查看全部平台 <ArrowRight size={15} />
            </button>
          )}
          <p className="pov-card-note">
            {allPlatforms
              ? '补齐可比回答与核实后，再判断差距'
              : '单个平台不作跨平台排名'}
          </p>
        </section>
      </div>
      {previewOnly && previewComparison}
      {!previewOnly && (
        <CompetitorCandidates
          key={batch.projectId + ':' + batch.id}
          projectId={batch.projectId}
          batchId={batch.id}
          revision={batch.updatedAt || batch.date}
          language={filters.language}
          engine={selectedEngine}
          presentation="overview"
          onOpen={onCompetitor}
        />
      )}

      <div className="pov-main-grid">
        <section
          className="pov-questions"
          ref={questionArea}
          aria-label="问题与回答"
        >
          <header>
            <h3>
              {focus === 'missed'
                ? allPlatforms
                  ? '已测结果均未出现的问题'
                  : sourceOnly
                    ? '未找到官方来源的问题'
                    : '未提及的问题'
                : focus === 'mentioned'
                  ? sourceOnly
                    ? '找到官方来源的问题'
                    : '已提及的问题'
                  : focus === 'cited'
                    ? '已确认官方引用的问题'
                    : focus === 'uncertain'
                      ? '引用待核实的问题'
                      : '重点改进'}{' '}
              <small>{selectedQuestions.length}</small>
            </h3>
            <button
              className="pov-text-link"
              onClick={
                focus === 'all'
                  ? () => {
                      onFilters({
                        engine: selectedEngine,
                        kind: 'all',
                        result: 'all',
                      });
                      onQuestions();
                    }
                  : () => setFocus('all')
              }
            >
              {focus === 'all' ? '全部搜索结果' : '重置筛选'}{' '}
              <ArrowRight size={13} />
            </button>
          </header>
          <OverviewPriorityQuestions
            projectId={batch.projectId}
            allQuestionIds={batch.questions.map(question => question.id)}
            key={`${batch.id}:${filters.language}:${selectedEngine}:${focus}`}
            previewOnly={previewOnly}
            questions={selectedQuestions}
            rows={rows}
            language={filters.language}
            onQuestion={onQuestion}
            onPlan={onPlan}
          />
          {!selectedQuestions.length && (
            <p className="pov-empty">
              当前筛选没有记录。
              <button className="pov-text-link" onClick={() => setFocus('all')}>
                查看本组全部问题
              </button>
            </p>
          )}
        </section>
        <section className="pov-platforms" aria-label="平台表现">
          <div className="pov-platform-primary">
            <h3>{allPlatforms ? '各平台结果' : '平台表现'}</h3>
            {platformResults.map((item) => {
              const ai = item.ai;
              const rate = ai ? item.mention.rate : item.official.rate;
              return (
                <div className="pov-bar" key={item.engine}>
                  <div>
                    <span>
                      {platformNames[item.engine]} ·{' '}
                      {ai ? '提及率' : '来源命中'}
                    </span>
                    <strong>{pct(rate)}</strong>
                  </div>
                  <div className="pov-track">
                    <span style={{ width: `${rate ?? 0}%` }} />
                  </div>
                </div>
              );
            })}
            <p>
              {allPlatforms
                ? 'AI 回答与网页搜索分别统计，暂不据此判断最强或最弱平台。'
                : sourceOnly && apiOnly
                  ? '此处统计 API 返回中的官方来源，不代表消费端提及率。'
                  : sourceOnly && googleOnly
                    ? '普通网页搜索，不属于 AI 回答。'
                    : `当前展示${aiPlatformLabel}的提及率。`}
            </p>
          </div>
          <div className="pov-workflow">{workflow}</div>
        </section>
      </div>

      <details className="pov-sources">
        <summary>
          {allPlatforms
            ? '各平台结果来源'
            : sourceOnly
              ? '最新记录的来源'
              : '最新回答附带的来源'}{' '}
          <span>{sources.length} 个页面</span>
          <ChevronDown size={14} />
        </summary>
        <p>
          按当前平台和语言的搜索记录汇总。页面每次出现在一条记录中计一次；采集时间见具体结果。
        </p>
        {sources
          .slice(0, allSources ? sources.length : 8)
          .map(({ source, rows: sourceRows }) => (
            <button
              className="pov-source-row"
              key={source.url}
              onClick={() => onSource(source, sourceRows)}
            >
              <span>{source.title || source.url}</span>
              <span>
                {sourceRows.length} 条
                {allPlatforms || sourceOnly ? '结果' : '回答'}{' '}
                <ArrowRight size={13} />
              </span>
            </button>
          ))}
        {!sources.length && <p>当前范围没有保存来源。</p>}
        {sources.length > 8 && (
          <button
            className="pov-text-link"
            onClick={() => setAllSources(!allSources)}
          >
            {allSources ? '收起' : `查看全部 ${sources.length} 个来源`}
          </button>
        )}
      </details>
      <details className="pov-method">
        <summary>
          统计口径与依据 <ChevronDown size={14} />
        </summary>
        <p>
          提及率：回答正文正确提到本项目；每条回答只计一次，同名对象和提问回显不计。自有内容引用率：正文确有引用指向已确认的自有页面；来源列表出现链接不自动算正文引用。未展开的引用组记为待核实。
        </p>
        <p>
          统计当前题单的全部问题，采用当前平台和语言下每道问题最近一次保存的结果，问题之间等权统计。未测不记零；存在未核实引用时，“至少”表示已确认引用占全部已测回答的下限，不将未知判为未引用。中英语言、AI
          回答与普通网页分别统计。
        </p>
        <p>
          竞品对照在同一批回答中匹配双方名称与别名，每题每入口使用最新记录，先在题内平均再对问题等权统计。正文缺失保留为待核实，来源列表不计正文提及；这项名称匹配预览不代表推荐或行业份额。
        </p>
        <p>
          正文审核按同项目、同批次、同语言和同一条回答匹配。新记录不继承旧审核；普通网页及纯搜索
          API 的官方来源发现单独统计，不代表 AI 提及或正文引用。
        </p>
        <button
          className="pov-text-link"
          onClick={() => onEvidence(batch.reportPath)}
        >
          本轮研究记录 <ExternalLink size={13} />
        </button>
      </details>
    </div>
  );
}

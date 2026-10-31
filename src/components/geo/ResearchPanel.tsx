'use client';

import { useEffect, useRef, useState } from 'react';
import Markdown from 'markdown-to-jsx';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CalendarDays,
  Info,
  ChevronDown,
  FileText,
  Search,
  X,
  Plus,
  Library,
} from 'lucide-react';
import type {
  ResearchBatch,
  ResearchEngine,
  ResearchQuestion,
  ResearchSource,
} from '@/lib/geo/research-types';
import {
  getLatestResearchObservation,
  getResearchRows,
  getResearchMetrics,
  isBrandQuestion,
  type ResearchFilter,
  type ResearchRow,
} from '@/lib/geo/research-view';
import {
  RESEARCH_ENGINES,
  RESEARCH_ENGINE_NAMES as names,
  getBatchResearchEngines,
  isResearchEngine,
  isConsumerResearchEngine,
} from '@/lib/geo/research-engines';
import './research-panel.css';
import './research-workspace.css';
import './question-detail.css';
import ResearchChart from './ResearchChart';
import QuestionDetailVisual from './QuestionDetailVisual';
import AnswerText from './AnswerText';
import GeoSelect from './GeoSelect';
import ProjectOverview, {
  OverviewMention,
  OverviewAudit,
  overviewObservationDates,
} from './ProjectOverview';
import ClaimReviewPanel, { type ClaimReviewInput } from './ClaimReviewPanel';
import { overviewProgress } from '@/lib/geo/overview-progress';
import type { GeoTask, GeoProject, ClaimReviewRecord } from '@/lib/geo/types';

type Props = {
  batch: ResearchBatch;
  project?: GeoProject;
  tasks?: GeoTask[];
  onTask?: (id: string) => void;
  onCompetitor?: () => void;
  view: 'overview' | 'questions';
  detailsOnly?: boolean;
  hideHeader?: boolean;
  onEvidence: (path: string) => void;
  onQuestions: () => void;
  onOverview: () => void;
  onReview: () => void;
  onImprove: (
    question: ResearchQuestion,
    language: 'zh' | 'en',
    engine: ResearchEngine,
  ) => void;
  claimReviews?: ClaimReviewRecord[];
  onPlan?: (question: ResearchQuestion, language: 'zh' | 'en', engine: ResearchEngine) => Promise<void>;
  onClaimReview?: (input: ClaimReviewInput) => Promise<void>;
};
type Drawer = {
  title: string;
  rows: ResearchRow[];
  question?: ResearchQuestion;
  source?: string;
  directory?: boolean;
  collection?: ResearchFilter['result'];
  engine?: ResearchFilter['engine'];
};
const initialFilters: ResearchFilter = {
  language: 'zh',
  engine: 'all',
  kind: 'all',
  result: 'all',
};
const kinds = {
  official: '官方来源',
  other: '第三方',
  self_submission: '自荐内容',
  mirror: '镜像',
};

export function clearResearchDetailParams(url: URL) {
  [
    'question',
    'record',
    'source',
    'directory',
    'collection',
    'evidence',
    'detail',
    'sourceUrl',
    'observationIndex',
    'returnTo',
    'batch',
    'history',
  ].forEach((key) => url.searchParams.delete(key));
}
function collectionTitle(
  engine: ResearchFilter['engine'],
  result: ResearchFilter['result'],
) {
  return (
    (engine === 'all' ? '所选入口' : names[engine]) +
    ' · ' +
    {
      all: '全部记录',
      found: '找到官方来源',
      not_observed: '本次未见官方来源',
      unmeasured: '未测问题',
    }[result]
  );
}

function safeUrl(value: string) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}
function statusText(row: ResearchRow) {
  if (!row.observation) return '未测';
  return row.observation.status === 'found' ? '已找到' : '本次未见';
}
function Status({ rows }: { rows: ResearchRow[] }) {
  const stats = getResearchMetrics(rows);
  const found = stats.found > 0;
  return (
    <span
      className={
        'rw-status ' + (found ? 'found' : !stats.completed ? 'unmeasured' : '')
      }
    >
      {found ? <Check size={13} /> : <span className="rw-dot" />}
      {found ? '已找到' : stats.completed ? '本次未见' : '未测'}
      {stats.completed > 1 && (
        <small>
          {stats.found}/{stats.completed}
        </small>
      )}
    </span>
  );
}
function SourceItem({
  source,
  assetHref,
}: {
  source: ResearchSource;
  assetHref?: string;
}) {
  const url = safeUrl(source.url);
  if (!url) return null;
  return (
    <li className="rw-source-item">
      <span className={'rw-source-kind ' + source.kind}>
        {kinds[source.kind]}
      </span>
      <div>
        <a href={url.href} target="_blank" rel="noopener noreferrer">
          {source.title || url.hostname}
          <ArrowUpRight size={13} />
        </a>
        <small>
          {url.hostname}
          {source.position !== undefined
            ? ' · 网页第 ' + source.position + ' 条'
            : ''}
        </small>
      </div>
      {assetHref && (
        <a
          className="rw-asset-link"
          href={assetHref}
          aria-label={'在内容资产中查看 ' + source.title}
          title="查看内容资产"
        >
          <Library size={16} />
        </a>
      )}
    </li>
  );
}
function Evidence({ projectId, path }: { projectId: string; path: string }) {
  const [record, setRecord] = useState<{
    content: string;
    format: string;
  } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setRecord(null);
    setError('');
    fetch(
      '/api/geo/evidence?project=' +
        encodeURIComponent(projectId) +
        '&path=' +
        encodeURIComponent(path),
      { signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error('这份记录暂时无法读取。');
        return response.json();
      })
      .then(setRecord)
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [projectId, path]);
  return (
    <section className="rw-evidence" aria-live="polite">
      <details className="rw-file-location">
        <summary>记录位置</summary>
        <p className="rw-path">{path}</p>
      </details>
      {error ? (
        <p role="alert">{error}</p>
      ) : !record ? (
        <p>正在读取原文…</p>
      ) : record.format === 'markdown' ? (
        <Markdown
          options={{
            disableParsingRawHTML: true,
            overrides: {
              a: {
                component: ({
                  href,
                  children,
                }: {
                  href?: string;
                  children: React.ReactNode;
                }) =>
                  href && safeUrl(href) ? (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  ) : (
                    <span>{children}</span>
                  ),
              },
            },
          }}
        >
          {record.content}
        </Markdown>
      ) : (
        <pre>{record.content}</pre>
      )}
    </section>
  );
}

export default function ResearchPanel({
  batch: latestBatch,
  project,
  tasks = [],
  onTask,
  onCompetitor,
  view,
  detailsOnly = false,
  hideHeader = false,
  onEvidence,
  onQuestions,
  onOverview,
  onReview,
  onImprove,
  onPlan,
  claimReviews = [],
  onClaimReview,
}: Props) {
  const projectNames = [project?.name];
  if (project?.repositoryUrl) {
    try {
      const repositoryName = new URL(project.repositoryUrl).pathname.split('/').filter(Boolean).at(-1)?.replace(/\.git$/, '');
      if (repositoryName) projectNames.push(repositoryName, repositoryName.replace(/[-_]/g, ' '));
    } catch { /* The project name remains usable when no repository URL is available. */ }
  }
  const [requestedBatch, setRequestedBatch] = useState('');
  const [historicalBatch, setHistoricalBatch] = useState<ResearchBatch | null>(
    null,
  );
  const [batchError, setBatchError] = useState('');
  const batch =
    historicalBatch?.id === requestedBatch &&
    historicalBatch.projectId === latestBatch.projectId
      ? historicalBatch
      : latestBatch;
  useEffect(() => {
    const read = () =>
      setRequestedBatch(
        new URLSearchParams(window.location.search).get('batch') || '',
      );
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, [latestBatch.projectId]);
  useEffect(() => {
    setBatchError('');
    if (!requestedBatch || requestedBatch === latestBatch.id) {
      setHistoricalBatch(null);
      return;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({
      project: latestBatch.projectId,
      batch: requestedBatch,
    });
    fetch(`/api/geo/research?${params}`, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        const body = await response.json();
        if (
          !response.ok ||
          body.batch?.id !== requestedBatch ||
          body.batch?.projectId !== latestBatch.projectId
        )
          throw new Error(body.error || '历史批次无法读取。');
        if (!controller.signal.aborted) setHistoricalBatch(body.batch);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setBatchError(
            error instanceof Error ? error.message : '历史批次无法读取。',
          );
      });
    return () => controller.abort();
  }, [requestedBatch, latestBatch.id, latestBatch.projectId]);
  const progress = overviewProgress(batch, tasks);
  const [filters, setFilters] = useState<ResearchFilter>({
    ...initialFilters,
  });
  const [query, setQuery] = useState('');
  const [deferred, setDeferred] = useState(false);
  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const [readPath, setReadPath] = useState<string | null>(null);
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const [traceError, setTraceError] = useState('');
  const [includeHistory, setIncludeHistory] = useState(false);
  const [linkedRecord, setLinkedRecord] = useState(false);
  const [selectedAnswerKey, setSelectedAnswerKey] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const listPosition = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const readLocation = () => {
      const params = new URLSearchParams(window.location.search);
      const returnPath = params.get('returnTo');
      let safeReturn: string | null = null;
      if (returnPath) {
        try {
          const target = new URL(returnPath, window.location.origin);
          if (
            target.origin === window.location.origin &&
            target.pathname === '/' &&
            ['assets', 'competitor', 'question-plan', 'overview', 'questions'].includes(
              target.searchParams.get('view') || '',
            ) &&
            target.searchParams.get('project') === batch.projectId
          )
            safeReturn = target.pathname + target.search;
        } catch {
          /* An invalid return location is never opened. */
        }
      }
      setReturnTo(safeReturn);
      setTraceError(
        params.has('batch') && params.get('batch') !== batch.id
          ? '这条链接属于其他研究批次，不能用本批记录替代。'
          : '',
      );
      const engine = params.get('engine');
      const kind = params.get('kind');
      const result = params.get('result');
      const next: ResearchFilter = {
        language: params.get('language') === 'en' ? 'en' : 'zh',
        engine: isResearchEngine(engine) ? engine : 'all',
        kind: kind === 'brand' || kind === 'discovery' ? kind : 'all',
        result:
          result === 'found' ||
          result === 'not_observed' ||
          result === 'unmeasured'
            ? result
            : 'all',
      };
      setFilters(next);
      setQuery(params.get('search') ?? '');
      setDeferred(params.get('group') === 'deferred');
      setReadPath(params.get('evidence'));
      if (params.has('batch') && params.get('batch') !== batch.id) {
        setTraceError(batchError);
        setDrawer({ title: batchError || '正在读取历史记录…', rows: [] });
        return;
      }
      const question = [...batch.questions, ...batch.deferredQuestions].find(
        (item) => item.id === params.get('question'),
      );
      const rows = getResearchRows(batch, { ...next, result: 'all' });
      const source = params.get('source');
      const record = params.get('record');
      const history = params.get('history') === 'all';
      setIncludeHistory(history);
      setLinkedRecord(!!record || params.has('observationIndex'));
      const collection = params.get('collection');
      if (source) {
        const matching = rows.filter((row) =>
          row.observation?.sources.some((item) => item.url === source),
        );
        setDrawer(
          matching.length
            ? {
                title: matching[0].observation!.sources.find(
                  (item) => item.url === source,
                )!.title,
                rows: matching,
                source,
              }
            : null,
        );
      } else if (params.get('directory') === 'sources') {
        setDrawer({ title: '全部来源页面', rows, directory: true });
      } else if (question) {
        const index = params.has('observationIndex')
          ? Number(params.get('observationIndex'))
          : null;
        const linkedSource = params.get('sourceUrl');
        const matchingRows = getResearchRows(
          batch,
          {
            ...next,
            kind: 'all',
            result: 'all',
          },
          {
            includeHistory:
              history || !!record || index !== null || !!linkedSource,
          },
        ).filter(
          (row) =>
            row.question.id === question.id &&
            (!record || row.key === record) &&
            (!params.has('batch') || params.get('batch') === batch.id) &&
            (index === null ||
              (Number.isInteger(index) &&
                index >= 0 &&
                row.observation === question.observations[index])) &&
            (!linkedSource ||
              row.observation?.sources.some(
                (source) => source.url === linkedSource,
              )),
        );
        if ((record || index !== null || linkedSource) && !matchingRows.length)
          setTraceError(
            '未找到这条链接对应的原始观测或来源，未显示其他记录代替。',
          );
        setDrawer({
          title: next.language === 'zh' ? question.zh : question.en,
          question,
          rows: matchingRows,
        });
      } else if (
        collection === 'all' ||
        collection === 'found' ||
        collection === 'not_observed' ||
        collection === 'unmeasured'
      ) {
        setDrawer({
          title: collectionTitle(next.engine, collection),
          rows: getResearchRows(batch, { ...next, result: collection }),
          collection,
          engine: next.engine,
        });
      } else setDrawer(null);
    };
    readLocation();
    window.addEventListener('popstate', readLocation);
    return () => window.removeEventListener('popstate', readLocation);
  }, [batch, view, detailsOnly, batchError]);

  useEffect(() => {
    if (drawer && !dialog.current?.open) {
      if (detailsOnly)
        listPosition.current = window.history.state?.opengeoDetailScroll ?? {
          x: window.scrollX,
          y: window.scrollY,
        };
      dialog.current?.showModal();
      if (listPosition.current)
        window.scrollTo(listPosition.current.x, listPosition.current.y);
    } else if (!drawer && dialog.current?.open) {
      dialog.current.close();
      if (listPosition.current) {
        window.scrollTo(listPosition.current.x, listPosition.current.y);
        listPosition.current = null;
      }
    }
  }, [drawer, detailsOnly]);

  function writeLocation(next: ResearchFilter) {
    setReturnTo(null);
    setTraceError('');
    const url = new URL(window.location.href);
    url.searchParams.set('language', next.language);
    url.searchParams.set('engine', next.engine);
    url.searchParams.set('kind', next.kind);
    url.searchParams.set('result', next.result);
    clearResearchDetailParams(url);
    window.history.replaceState(null, '', url);
  }
  function changeFilters(change: Partial<ResearchFilter>) {
    const next = { ...filters, ...change };
    setFilters(next);
    writeLocation(next);
  }
  function closeDrawer() {
    if (window.history.state?.opengeoDetail) {
      window.history.back();
      return;
    }
    setDrawer(null);
    setReadPath(null);
    if (detailsOnly) {
      const url = new URL(
        returnTo || window.location.href,
        window.location.origin,
      );
      clearResearchDetailParams(url);
      window.history.replaceState(null, '', url);
      window.dispatchEvent(new PopStateEvent('popstate'));
      return;
    }
    writeLocation(filters);
  }
  function showDrawer(next: Drawer) {
    const url = new URL(window.location.href);
    clearResearchDetailParams(url);
    if (detailsOnly) {
      url.searchParams.set('batch', batch.id);
      if (returnTo) url.searchParams.set('returnTo', returnTo);
    }
    url.searchParams.set('language', filters.language);
    if (next.engine) url.searchParams.set('engine', next.engine);
    if (next.question) url.searchParams.set('question', next.question.id);
    if (
      next.rows.length === 1 &&
      next.question &&
      next.question.decision !== 'keep_and_fill'
    )
      url.searchParams.set('record', next.rows[0].key);
    if (next.source) url.searchParams.set('source', next.source);
    if (next.directory) url.searchParams.set('directory', 'sources');
    if (next.collection) url.searchParams.set('collection', next.collection);
    url.searchParams.set('detail', 'answers');
    const state = {
      ...window.history.state,
      opengeoDetail: !drawer || !!window.history.state?.opengeoDetail,
    };
    window.history[drawer ? 'replaceState' : 'pushState'](state, '', url);
    setReadPath(null);
    setIncludeHistory(false);
    setLinkedRecord(false);
    setDrawer(next);
  }
  function readEvidence(path: string | null) {
    setReadPath(path);
    const url = new URL(window.location.href);
    if (path) url.searchParams.set('evidence', path);
    else url.searchParams.delete('evidence');
    window.history.replaceState(
      {
        ...window.history.state,
        opengeoDetail: !!window.history.state?.opengeoDetail,
      },
      '',
      url,
    );
  }
  function assetHref(
    url: string,
    engine?: ResearchRow['engine'],
    row?: ResearchRow,
  ) {
    const selectedEngine =
      engine ?? (filters.engine === 'all' ? undefined : filters.engine);
    if (!selectedEngine || !isConsumerResearchEngine(selectedEngine))
      return undefined;
    return (
      '/?' +
      new URLSearchParams({
        view: 'assets',
        project: batch.projectId,
        assetUrl: url,
        batch: batch.id,
        ...(row?.observation
          ? {
              assetQuestion: row.question.id,
              observationIndex: String(
                row.question.observations.indexOf(row.observation),
              ),
            }
          : {}),
        assetDetail: 'references',
        language: filters.language,
        engine: selectedEngine,
      })
    );
  }
  function changeGroup(isDeferred: boolean) {
    setDeferred(isDeferred);
    const url = new URL(window.location.href);
    if (isDeferred) url.searchParams.set('group', 'deferred');
    else url.searchParams.delete('group');
    window.history.replaceState(null, '', url);
  }
  function searchQuestions(value: string) {
    setQuery(value);
    const url = new URL(window.location.href);
    if (value) url.searchParams.set('search', value);
    else url.searchParams.delete('search');
    window.history.replaceState(null, '', url);
  }

  const baseRows = getResearchRows(batch, { ...filters, result: 'all' });
  const visibleRows = getResearchRows(batch, filters);
  const metrics = getResearchMetrics(baseRows);
  const displayedEngines =
    filters.engine === 'all'
      ? getBatchResearchEngines(batch)
      : [filters.engine];
  const activeQuestions = (
    view === 'questions' && deferred ? batch.deferredQuestions : batch.questions
  ).filter((question) =>
    view === 'overview'
      ? baseRows.some((row) => row.question.id === question.id)
      : (deferred || baseRows.some((row) => row.question.id === question.id)) &&
        (question.zh + ' ' + question.en + ' ' + question.id)
          .toLowerCase()
          .includes(query.toLowerCase()) &&
        (deferred ||
          visibleRows.some((row) => row.question.id === question.id)),
  );
  function openQuestion(
    question: ResearchQuestion,
    engine?: ResearchRow['engine'],
  ) {
    const selected = engine ? { ...filters, engine } : filters;
    showDrawer({
      title: filters.language === 'zh' ? question.zh : question.en,
      question,
      engine: selected.engine,
      rows: getResearchRows(batch, {
        ...selected,
        kind: 'all',
        result: 'all',
      }).filter((row) => row.question.id === question.id),
    });
  }
  function openCollection(
    engine: ResearchFilter['engine'],
    result: ResearchFilter['result'],
  ) {
    const rows = getResearchRows(batch, { ...filters, engine, result });
    showDrawer({
      title: collectionTitle(engine, result),
      rows,
      engine,
      collection: result,
    });
  }
  function showQuestionHistory(value: boolean) {
    const url = new URL(window.location.href);
    ['record', 'observationIndex', 'sourceUrl', 'evidence'].forEach((key) =>
      url.searchParams.delete(key),
    );
    if (value) url.searchParams.set('history', 'all');
    else url.searchParams.delete('history');
    window.history.replaceState(window.history.state, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
  const activeAnswerKey = drawer?.rows.some(
    (row) => row.key === selectedAnswerKey,
  )
    ? selectedAnswerKey
    : drawer?.rows.find((row) => row.observation)?.key ||
      drawer?.rows[0]?.key ||
      '';
  const activeAnswer = drawer?.rows.find((row) => row.key === activeAnswerKey);
  // A deep link can point to either a current or older answer. Its exact-record
  // filter stays intact; the two visible choices describe the answer's age.
  const showingHistory = includeHistory || !!(
    activeAnswer?.observation &&
    activeAnswer.observation !== getLatestResearchObservation(
      activeAnswer.question.observations.filter((observation) =>
        observation.engine === activeAnswer.engine &&
        observation.language === activeAnswer.observation!.language,
      ),
    )
  );
  const sourceMap = new Map<
    string,
    { source: ResearchSource; rows: ResearchRow[] }
  >();
  for (const row of baseRows) {
    for (const source of row.observation?.sources ?? []) {
      if (!safeUrl(source.url)) continue;
      const saved = sourceMap.get(source.url) ?? { source, rows: [] };
      if (!saved.rows.some((item) => item.key === row.key))
        saved.rows.push(row);
      sourceMap.set(source.url, saved);
    }
  }
  const sources = [...sourceMap.values()].sort(
    (a, b) => b.rows.length - a.rows.length,
  );
  const sourcePreview = sources.slice(0, 5);
  const brandCount = batch.questions.filter(isBrandQuestion).length;
  const questionsLabel =
    filters.kind === 'brand'
      ? '品牌基础'
      : filters.kind === 'discovery'
        ? '需求发现'
        : '全部问题';

  const toolbar = (
    <div className="rw-toolbar">
      <span className="rw-date">
        <CalendarDays size={15} />
        {(batch.updatedAt || batch.date).slice(0, 10)} · 各题最新
      </span>
      <label>
        <span className="rw-sr-only">搜索入口</span>
        <GeoSelect<ResearchFilter['engine']>
          label="搜索入口"
          value={filters.engine}
          onChange={(engine) => changeFilters({ engine })}
          options={[
            { value: 'all', label: '全部入口' },
            ...RESEARCH_ENGINES.map((engine) => ({ value: engine, label: names[engine] })),
          ]}
        />
      </label>
      {view === 'overview' && (
        <label>
          <span className="rw-sr-only">问题类型</span>
          <GeoSelect<ResearchFilter['kind']>
            label="问题类型"
            value={filters.kind}
            onChange={(kind) => changeFilters({ kind })}
            options={[
              { value: 'all', label: '全部问题' },
              { value: 'brand', label: '品牌基础' },
              { value: 'discovery', label: '需求发现' },
            ]}
          />
        </label>
      )}
      <div className="rw-language" role="group" aria-label="问法语言">
        <button
          aria-pressed={filters.language === 'zh'}
          onClick={() => changeFilters({ language: 'zh' })}
        >
          中文
        </button>
        <button
          aria-pressed={filters.language === 'en'}
          onClick={() => changeFilters({ language: 'en' })}
        >
          English
        </button>
      </div>
    </div>
  );
  const pageContent = detailsOnly ? null : (
    <>
      {!hideHeader && (
        <header className="rw-page-heading">
          <div className="rw-heading-title">
            <a
              className="rw-brand"
              href={`/?view=overview&project=${batch.projectId}`}
            >
              <span>O</span> OpenGEO
            </a>
            <h1>{view === 'overview' ? '项目概览' : '搜索结果'}</h1>
          </div>
          <form
            className="rw-global-search"
            onSubmit={(event) => {
              event.preventDefault();
              onQuestions();
            }}
          >
            <Search size={15} />
            <input
              aria-label="搜索项目内问题"
              placeholder="搜索项目内问题…"
              value={query}
              onChange={(event) => searchQuestions(event.target.value)}
            />
          </form>
          <button
            className="rw-button"
            onClick={() => onEvidence(batch.reportPath)}
          >
            <FileText size={15} /> 研究报告
          </button>
        </header>
      )}
      <div className="rw-body">
        {view === 'overview' ? (
          <ProjectOverview
            batch={batch}
            filters={filters}
            onFilters={changeFilters}
            onQuestion={openQuestion}
            onPlan={onPlan}
            onQuestions={onQuestions}
            onEvidence={onEvidence}
            onCompetitor={onCompetitor ?? (() => {})}
            onSource={(source, rows) =>
              showDrawer({
                title: source.title,
                rows,
                source: source.url,
                engine:
                  filters.engine === 'all' ||
                  new Set(rows.map((row) => row.engine)).size > 1
                    ? 'all'
                    : (rows[0]?.engine ?? filters.engine),
              })
            }
            workflow={
              <details className="rw-workflow">
                <summary>
                  第 {progress.step} 环 · {progress.label}{' '}
                  <ChevronDown size={13} />
                </summary>
                <ol className="rw-progress" aria-label="本轮五环进度">
                  {progress.steps.map((item, index) => (
                    <li
                      key={item.title}
                      className={index + 1 === progress.step ? 'current' : ''}
                    >
                      <span className="rw-step">{index + 1}</span>
                      {item.title}
                      <span>{item.status}</span>
                    </li>
                  ))}
                </ol>
                {progress.taskId && onTask && (
                  <button
                    className="pov-text-link"
                    onClick={() => onTask(progress.taskId!)}
                  >
                    {progress.action} <ArrowRight size={13} />
                  </button>
                )}
              </details>
            }
          />
        ) : (
          <>
            <div className="rw-questions-grid">
              <aside className="rw-groups" aria-label="问题分类">
                <h2>问题分类</h2>
                {(
                  [
                    ['all', '全部问题', batch.questions.length],
                    ['brand', '品牌基础', brandCount],
                    [
                      'discovery',
                      '需求发现',
                      batch.questions.length - brandCount,
                    ],
                  ] as const
                ).map(([kind, label, count]) => (
                  <button
                    key={kind}
                    aria-pressed={!deferred && filters.kind === kind}
                    onClick={() => {
                      changeGroup(false);
                      changeFilters({ kind, result: 'all' });
                    }}
                  >
                    <span>{label}</span>
                    <small>{count}</small>
                  </button>
                ))}
                <button
                  aria-pressed={deferred}
                  onClick={() => {
                    changeGroup(true);
                    changeFilters({ kind: 'all', result: 'all' });
                  }}
                >
                  <span>保留待补</span>
                  <small>{batch.deferredQuestions.length}</small>
                </button>

                <button
                  className="rw-muted-link"
                  onClick={() => onEvidence(batch.reviewPath)}
                >
                  题单审核依据 <ArrowUpRight size={13} />
                </button>
              </aside>
              <section className="rw-question-section">
                {toolbar}
                <header className="rw-section-heading">
                  <div>
                    <h2>{deferred ? '保留待补' : questionsLabel}</h2>
                    <span>{activeQuestions.length} 个问题</span>
                  </div>
                  <button className="rw-primary" onClick={onReview}>
                    <Plus size={15} /> 管理问题
                  </button>
                </header>
                <div className="rw-list-tools">
                  <label className="rw-search">
                    <Search size={15} />
                    <input
                      aria-label="搜索本批问题"
                      placeholder="搜索问题…"
                      value={query}
                      onChange={(event) => searchQuestions(event.target.value)}
                    />
                  </label>
                  {!deferred && (
                    <GeoSelect<ResearchFilter['result']>
                      label="观测状态"
                      value={filters.result}
                      onChange={(result) => changeFilters({ result })}
                      options={[
                        { value: 'all', label: '全部状态' },
                        { value: 'found', label: '已找到' },
                        { value: 'not_observed', label: '本次未见' },
                        { value: 'unmeasured', label: '未测' },
                      ]}
                    />
                  )}
                </div>
                <div className="rw-table-scroll">
                  <table className="rw-table">
                    <thead>
                      <tr>
                        <th>问题</th>
                        {displayedEngines.map((engine) => (
                          <th key={engine}>{names[engine]}</th>
                        ))}
                        <th>
                          <span className="rw-sr-only">详情</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeQuestions.map((question) => {
                        const rows = baseRows.filter(
                          (row) => row.question.id === question.id,
                        );
                        return (
                          <tr key={question.id}>
                            <td>
                              <button
                                className="rw-question-title"
                                onClick={() => openQuestion(question)}
                              >
                                <strong
                                  title={
                                    filters.language === 'zh'
                                      ? question.zh
                                      : question.en
                                  }
                                  lang={filters.language === 'en' ? 'en' : 'zh'}
                                >
                                  {filters.language === 'zh'
                                    ? question.zh
                                    : question.en}
                                </strong>
                              </button>
                              {view === 'questions' && (
                                <p
                                  className="rw-question-value"
                                  title={question.valueReason}
                                >
                                  {question.valueReason}
                                </p>
                              )}
                            </td>
                            {displayedEngines.map((engine) => (
                              <td key={engine}>
                                <button
                                  className="rw-cell-action"
                                  aria-label={
                                    question[filters.language] +
                                    ' · ' +
                                    names[engine] +
                                    ' 记录'
                                  }
                                  onClick={() => openQuestion(question, engine)}
                                >
                                  <Status
                                    rows={rows.filter(
                                      (row) => row.engine === engine,
                                    )}
                                  />
                                </button>
                              </td>
                            ))}
                            <td>
                              <button
                                className="rw-row-open"
                                aria-label={
                                  '查看问题：' + question[filters.language]
                                }
                                onClick={() => openQuestion(question)}
                              >
                                <ArrowRight size={16} />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {!activeQuestions.length && (
                  <div className="rw-empty">
                    当前筛选下没有问题。
                    <button
                      onClick={() => {
                        searchQuestions('');
                        changeGroup(false);
                        changeFilters({ kind: 'all', result: 'all' });
                      }}
                    >
                      查看全部问题
                    </button>
                  </div>
                )}
              </section>
            </div>
            <details className="rw-notes">
              <summary>
                调查依据与观测范围 <ChevronDown size={14} />
              </summary>
              <p>{batch.productSummary}</p>
              <p>{batch.contributionSummary}</p>
              <p>{batch.scopeNote}</p>
              <p>
                “本次未见”只表示这次观测没有找到官方来源，不代表未收录。中英问法共用题目
                ID，结果分别记录。
              </p>
              <p>
                列表与统计取每个问题、语言、入口的最新记录，可能来自不同日期。历史记录保留在问题详情。Google
                指常规网页结果；DeepSeek、通义千问与豆包为 API
                入口，不代表其消费端结果。此处不是综合评分，也不代表全网发现率。
              </p>
              <p>
                <strong>下一步：</strong>
                {batch.nextStep}
              </p>
              <div>
                <button onClick={() => onEvidence(batch.sourceAuditPath)}>
                  产品调查依据 <ArrowUpRight size={13} />
                </button>
                <button onClick={() => onEvidence(batch.reviewPath)}>
                  题单审核依据 <ArrowUpRight size={13} />
                </button>
              </div>
            </details>
          </>
        )}
      </div>
    </>
  );
  return (
    <div className={`rw-page rw-${view}`}>
      {pageContent}
      <dialog
        ref={dialog}
        className={
          'rw-dialog' + (drawer?.question ? ' rw-question-detail' : '')
        }
        aria-labelledby="rw-detail-title"
        onCancel={(event) => {
          event.preventDefault();
          closeDrawer();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeDrawer();
        }}
      >
        {drawer && (
          <div className="rw-detail-surface">
            <header className="rw-detail-header">
              {detailsOnly && drawer.question ? (
                <button onClick={closeDrawer}>← 返回问题列表</button>
              ) : (
                <span>
                  {readPath
                    ? '原始记录'
                    : drawer.question
                      ? '问题详情'
                      : '观测记录'}
                </span>
              )}
              <button aria-label="关闭详情" onClick={closeDrawer} autoFocus>
                <X size={20} />
              </button>
            </header>
            <div className="rw-detail-scroll">
              {returnTo && (!drawer.question || !detailsOnly) && (
                <a
                  className="rw-button"
                  href={returnTo}
                  onClick={(event) => {
                    if (
                      detailsOnly &&
                      new URL(
                        returnTo,
                        window.location.origin,
                      ).searchParams.get('view') === 'question-plan'
                    ) {
                      event.preventDefault();
                      closeDrawer();
                    }
                  }}
                >
                  ← 返回来源位置
                </a>
              )}
              {traceError && <p role="alert">{traceError}</p>}
              <div className="rw-detail-title">
                <h2 id="rw-detail-title" className={drawer.question && !readPath && drawer.rows.length ? 'rw-reading-title' : undefined}>{drawer.title}</h2>
                <p>
                  {view === 'overview' || drawer.question
                    ? overviewObservationDates(drawer.rows)
                    : (batch.updatedAt || batch.date).slice(0, 10)}{' '}
                  · {filters.language === 'zh' ? '中文问法' : 'English query'} ·{' '}
                  {drawer.directory
                    ? sources.length + ' 个来源页面'
                    : drawer.rows.filter((row) => row.observation).length +
                      (showingHistory ? ' 条历史记录' : ' 条记录')}
                </p>
                {drawer.question && (
                  <div
                    className="rw-history-switch"
                    role="group"
                    aria-label="记录范围"
                  >
                    <button
                      aria-pressed={!showingHistory}
                      onClick={() => showQuestionHistory(false)}
                    >
                      最新回答
                    </button>
                    <button
                      aria-pressed={showingHistory}
                      onClick={() => showQuestionHistory(true)}
                    >
                      历史回答
                    </button>
                  </div>
                )}
              </div>
              {drawer.source && safeUrl(drawer.source) && (
                <div className="rw-source-actions">
                  <a
                    className="rw-source-out"
                    href={drawer.source}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    打开来源页面 <ArrowUpRight size={14} />
                  </a>
                  {drawer.rows[0] &&
                    isConsumerResearchEngine(drawer.rows[0].engine) && (
                      <a
                        className="rw-button"
                        href={assetHref(drawer.source, drawer.rows[0].engine)}
                      >
                        <Library size={14} /> 查看内容资产
                      </a>
                    )}
                </div>
              )}
              {readPath ? (
                <>
                  <button
                    className="rw-back"
                    onClick={() => readEvidence(null)}
                  >
                    ← 返回详情
                  </button>
                  <Evidence projectId={batch.projectId} path={readPath} />
                </>
              ) : drawer.directory ? (
                <div className="rw-source-directory">
                  <div className="rw-source-columns">
                    <span>来源页面</span>
                    <span>记录数</span>
                  </div>
                  {sources.map(({ source, rows }, index) => (
                    <button
                      className="rw-source-preview"
                      key={source.url}
                      onClick={() =>
                        showDrawer({
                          title: source.title,
                          source: source.url,
                          rows,
                        })
                      }
                    >
                      <span className="rw-source-rank">{index + 1}</span>
                      <span className="rw-source-description">
                        <strong>{source.title}</strong>
                        <small>
                          {safeUrl(source.url)?.hostname} · {kinds[source.kind]}
                        </small>
                      </span>
                      <span className="rw-source-count">{rows.length}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <>
                  {drawer.question && !traceError && (
                    <QuestionDetailVisual
                      projectId={batch.projectId}
                      batchId={batch.id}
                      questionId={drawer.question.id}
                      language={filters.language}
                      engine={filters.engine}
                      history={includeHistory || linkedRecord}
                      revision={batch.updatedAt || batch.date}
                      recordKeys={drawer.rows.map((row) => row.key)}
                      selectedKey={activeAnswerKey}
                      onSelect={setSelectedAnswerKey}
                    />
                  )}
                  <div
                    className={
                      'rw-answer-list' +
                      (drawer.question ? ' rw-question-answers' : '')
                    }
                  >
                    {view !== 'overview' &&
                      !!drawer.rows.length &&
                      !drawer.question && (
                        <div className="rw-detail-analysis">
                          <ResearchChart
                            rows={drawer.rows}
                            date={batch.date}
                            compact
                            onOpen={(engine) =>
                              drawer.question
                                ? openQuestion(drawer.question, engine)
                                : openCollection(engine, 'all')
                            }
                          />
                          <ResearchChart
                            rows={drawer.rows}
                            date={batch.date}
                            compact
                            byPlatform
                            onOpen={(engine) =>
                              drawer.question
                                ? openQuestion(drawer.question, engine)
                                : openCollection(engine, 'all')
                            }
                          />
                        </div>
                      )}
                    {!!drawer.rows.length && !drawer.question && (
                      <div className="rw-record-table-heading">
                        <span>执行记录</span>
                        <span>
                          {view === 'overview' &&
                          drawer.rows.every((row) => row.engine === 'chatgpt')
                            ? '正文提及'
                            : '官方来源'}
                        </span>
                        <span>来源数</span>
                      </div>
                    )}
                    {!drawer.rows.length && (
                      <div className="rw-empty">
                        {drawer.question
                          ? '这道题尚无搜索记录。'
                          : '当前范围没有符合条件的记录。返回概览可查看全部已测结果。'}
                      </div>
                    )}
                    {(drawer.question
                      ? drawer.rows.filter((row) => row.key === activeAnswerKey)
                      : drawer.rows
                    ).map((row) => (
                      <details
                        className="rw-answer"
                        key={row.key}
                        open={!!drawer.question || drawer.rows.length === 1}
                      >
                        <summary className="rw-answer-heading">
                          <span className="rw-answer-platform">
                            <span className={'rw-engine-icon ' + row.engine}>
                              {names[row.engine][0]}
                            </span>
                            <strong>{names[row.engine]}</strong>
                            <span>
                              {row.engine === 'google'
                                ? '网页搜索'
                                : row.engine === 'deepseek'
                                  ? '搜索 API'
                                  : 'AI 回答'}
                            </span>
                          </span>
                          {view === 'overview' && row.engine === 'chatgpt' ? (
                            <OverviewMention batch={batch} row={row} />
                          ) : drawer.question ? (
                            <span
                              className={
                                'rw-status ' +
                                (row.observation?.status === 'found'
                                  ? 'found'
                                  : '')
                              }
                            >
                              {row.observation?.status === 'found' ? (
                                <Check size={13} />
                              ) : (
                                <span className="rw-dot" />
                              )}
                              {!row.observation
                                ? '尚未搜索'
                                : row.observation.status === 'found'
                                  ? '含官方来源'
                                  : '未见官方来源'}
                            </span>
                          ) : (
                            <Status rows={[row]} />
                          )}
                          <span className="rw-record-count">
                            {row.observation?.sources.length ?? '—'} 个来源
                          </span>
                          <ChevronDown size={15} />
                          <span className="rw-record-preview">
                            {!drawer.question
                              ? (filters.language === 'zh'
                                  ? row.question.zh
                                  : row.question.en) + ' · '
                              : ''}
                            {row.observation
                              ? view === 'overview'
                                ? row.observation.summary.replace(
                                    /^(完整可见正文未观察到我方提及及官方来源。|正文提及并给出我方官方来源。)/,
                                    '',
                                  )
                                : row.observation.summary
                              : '尚无该入口的观测记录'}
                          </span>
                        </summary>
                        <div
                          className={
                            'rw-answer-body' +
                            (drawer.question
                              ? ' rw-question-reading' +
                                (row.engine === 'google' ||
                                row.engine === 'deepseek'
                                  ? ' rw-search-reading'
                                  : ' rw-answer-reading')
                              : '')
                          }
                        >
                          {drawer.question &&
                            row.engine !== 'google' &&
                            row.engine !== 'deepseek' && (
                              <AnswerText
                                key={row.key}
                                projectId={batch.projectId}
                                path={row.observation?.answerPath}
                                projectNames={projectNames.filter((name): name is string => Boolean(name))}
                              />
                            )}
                          {drawer.question && (
                            <div className="rw-prompt">
                              <h3>
                                {row.observation ? '本次问法' : '待搜索问题'}
                              </h3>
                              <p>
                                {row.observation?.query ||
                                  (filters.language === 'zh'
                                    ? row.question.zh
                                    : row.question.en)}
                              </p>
                            </div>
                          )}
                          {view === 'overview' && (
                            <OverviewAudit batch={batch} row={row} />
                          )}
                          {!drawer.question && (
                            <p className="rw-answer-question">
                              {filters.language === 'zh'
                                ? row.question.zh
                                : row.question.en}
                            </p>
                          )}
                          {row.observation ? (
                            <>
                              {!drawer.question && (
                                <>
                                  <p className="rw-summary">
                                    {row.observation.summary}
                                  </p>
                                  {row.observation.overviewStatus && (
                                    <p className="rw-overview-state">
                                      Google AI 概览：
                                      {(
                                        {
                                          generated: '已生成',
                                          generation_failed: '生成失败',
                                          not_shown: '未显示',
                                        } as Record<string, string>
                                      )[row.observation.overviewStatus] ??
                                        row.observation.overviewStatus}
                                    </p>
                                  )}
                                </>
                              )}
                              <footer>
                                {!drawer.question && (
                                  <button
                                    className="rw-button"
                                    onClick={() =>
                                      readEvidence(
                                        row.observation!.answerPath ??
                                          row.observation!.evidencePath,
                                      )
                                    }
                                  >
                                    {row.engine === 'google' ||
                                    row.engine === 'deepseek'
                                      ? '完整搜索记录'
                                      : '完整回答'}{' '}
                                    <ArrowRight size={14} />
                                  </button>
                                )}
                                <button
                                  className="rw-muted-link"
                                  onClick={() =>
                                    readEvidence(row.observation!.evidencePath)
                                  }
                                >
                                  原始记录 <FileText size={13} />
                                </button>
                              </footer>
                              {(row.observation.sources.length > 0 ||
                                (drawer.question &&
                                  (row.engine === 'google' ||
                                    row.engine === 'deepseek'))) && (
                                <details
                                  className="rw-record-sources"
                                  open={
                                    !!drawer.question &&
                                    (row.engine === 'google' ||
                                      row.engine === 'deepseek')
                                  }
                                >
                                  <summary>
                                    {row.engine === 'google' ||
                                    row.engine === 'deepseek'
                                      ? '搜索结果'
                                      : '引用网页'}{' '}
                                    <span>
                                      {row.observation.sources.length}
                                    </span>
                                    <ChevronDown size={14} />
                                  </summary>
                                  {drawer.question &&
                                    row.engine === 'google' &&
                                    row.observation.overviewStatus && (
                                      <p className="rw-overview-state">
                                        {row.observation.overviewStatus ===
                                        'generation_failed'
                                          ? '本次 AI 概览生成失败'
                                          : row.observation.overviewStatus ===
                                              'not_shown'
                                            ? '本次未显示 AI 概览'
                                            : '本次已生成 AI 概览 · 下方为网页结果'}
                                      </p>
                                    )}
                                  {!row.observation.sources.length && (
                                    <p className="rw-answer-placeholder">
                                      本次没有返回网页结果。
                                    </p>
                                  )}
                                  <ul className="rw-source-list">
                                    {(drawer.question
                                      ? row.observation.sources.slice(0, 3)
                                      : row.observation.sources
                                    ).map((source, index) => (
                                      <SourceItem
                                        key={source.url + index}
                                        source={source}
                                        assetHref={assetHref(
                                          source.url,
                                          row.engine,
                                          row,
                                        )}
                                      />
                                    ))}
                                  </ul>
                                  {drawer.question &&
                                    row.observation.sources.length > 3 && (
                                      <details className="rw-question-more-sources">
                                        <summary>
                                          其余{' '}
                                          {row.observation.sources.length - 3}{' '}
                                          个来源 <ChevronDown size={13} />
                                        </summary>
                                        <ul className="rw-source-list">
                                          {row.observation.sources
                                            .slice(3)
                                            .map((source, index) => (
                                              <SourceItem
                                                key={source.url + index}
                                                source={source}
                                                assetHref={assetHref(
                                                  source.url,
                                                  row.engine,
                                                  row,
                                                )}
                                              />
                                            ))}
                                        </ul>
                                      </details>
                                    )}
                                </details>
                              )}

                              <details className="rw-record-conditions">
                                <summary>
                                  {drawer.question
                                    ? '搜索条件与时间'
                                    : '原始问法、条件与时间'}{' '}
                                  <ChevronDown size={13} />
                                </summary>
                                {!drawer.question && (
                                  <p>{row.observation.query}</p>
                                )}
                                <p>{row.observation.conditions}</p>
                                <p>{row.observation.recordedAt}</p>
                              </details>
                              {onClaimReview &&
                                row.engine === 'chatgpt' &&
                                row.observation.answerPath && (
                                  <ClaimReviewPanel
                                    projectId={batch.projectId}
                                    batchId={batch.id}
                                    question={row.question}
                                    observationIndex={row.question.observations.indexOf(
                                      row.observation,
                                    )}
                                    observation={row.observation}
                                    records={claimReviews}
                                    onSave={onClaimReview}
                                  />
                                )}
                            </>
                          ) : (
                            <p className="rw-summary">
                              {statusText(row)} · 没有该语言与入口的观察记录。
                            </p>
                          )}
                        </div>
                      </details>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </dialog>
    </div>
  );
}

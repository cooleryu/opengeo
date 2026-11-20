'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Markdown from 'markdown-to-jsx';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Info,
  ChevronDown,
  FileText,
  Search,
  X,
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
  type ResearchFilter,
  type ResearchRow,
} from '@/lib/geo/research-view';
import {
  RESEARCH_ENGINE_NAMES as names,
  isResearchEngine,
  isConsumerResearchEngine,
} from '@/lib/geo/research-engines';
import './research-workspace.css';
import './question-detail.css';
import ResearchChart from './ResearchChart';
import OpenGeoBrandMark from './OpenGeoBrandMark';
import QuestionDetailVisual from './QuestionDetailVisual';
import AnswerText from './AnswerText';
import ProjectOverview, {
  OverviewMention,
  OverviewAudit,
  overviewObservationDates,
} from './ProjectOverview';
import type { ClaimReviewInput } from './ClaimReviewPanel';
import { overviewProgress } from '@/lib/geo/overview-progress';
import { inferContentLang, plural, resolveProjectTargetLanguage } from '@/lib/geo/i18n';
import { isAiAnswerRow } from '@/lib/geo/overview-metrics';
import { sameCanonicalSource } from '@/lib/geo/overview-sources';
import type { GeoTask, GeoProject, ClaimReviewRecord } from '@/lib/geo/types';
import { useUiLanguage } from './UiLanguageContext';

type Props = {
  projectOptimization?: ReactNode;
  activeOptimizationRunId?: string | null;
  latestShippedAt?: string | null;
  batch: ResearchBatch;
  project?: GeoProject;
  tasks?: GeoTask[];
  onTask?: (id: string) => void;
  onCompetitor?: () => void;
  onAssets?: () => void;
  view: 'overview' | 'questions';
  detailsOnly?: boolean;
  hideHeader?: boolean;
  onEvidence: (path: string) => void;
  onQuestions: () => void;
  onRefresh?: () => void;
  onOverview: () => void;
  onReview: () => void;
  onImprove: (
    question: ResearchQuestion,
    language: 'zh' | 'en',
    engine: ResearchEngine,
  ) => void;
  claimReviews?: ClaimReviewRecord[];
  onPlan?: (
    question?: ResearchQuestion,
    language?: 'zh' | 'en',
    engine?: ResearchEngine,
  ) => Promise<void> | void;
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
  official: { en: 'Official source', zh: '官方来源' },
  other: { en: 'Third-party', zh: '第三方' },
  self_submission: { en: 'Self-submitted', zh: '自荐内容' },
  mirror: { en: 'Mirror', zh: '镜像' },
} as const;

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
  isEn: boolean,
) {
  const resultLabels: Record<ResearchFilter['result'], { en: string; zh: string }> = {
    all: { en: 'All records', zh: '全部记录' },
    found: { en: 'Official source found', zh: '找到官方来源' },
    not_observed: { en: 'No official source seen', zh: '本次未见官方来源' },
    unmeasured: { en: 'Unmeasured questions', zh: '未测问题' },
  };
  return (
    (engine === 'all' ? (isEn ? 'Selected platforms' : '所选入口') : names[engine]) +
    ' · ' +
    (isEn ? resultLabels[result].en : resultLabels[result].zh)
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
function statusText(row: ResearchRow, isEn: boolean) {
  if (!row.observation) return isEn ? 'Unmeasured' : '未测';
  return row.observation.status === 'found'
    ? isEn
      ? 'Found'
      : '已找到'
    : isEn
      ? 'Not seen'
      : '本次未见';
}
function Status({ rows }: { rows: ResearchRow[] }) {
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const stats = getResearchMetrics(rows);
  const found = stats.found > 0;
  return (
    <span
      className={
        'rw-status ' + (found ? 'found' : !stats.completed ? 'unmeasured' : '')
      }
    >
      {found ? <Check size={13} /> : <span className="rw-dot" />}
      {found
        ? isEn
          ? 'Found'
          : '已找到'
        : stats.completed
          ? isEn
            ? 'Not seen'
            : '本次未见'
          : isEn
            ? 'Unmeasured'
            : '未测'}
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
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const url = safeUrl(source.url);
  if (!url) return null;
  return (
    <li className="rw-source-item">
      <span className={'rw-source-kind ' + source.kind}>
        {isEn ? kinds[source.kind].en : kinds[source.kind].zh}
      </span>
      <div>
        <a
          href={url.href}
          target="_blank"
          rel="noopener noreferrer"
          data-i18n-skip=""
        >
          {source.title || url.hostname}
          <ArrowUpRight size={13} />
        </a>
        <small>
          <span data-i18n-skip="">{url.hostname}</span>
          {source.position !== undefined
            ? isEn
              ? ` · Web #${source.position}`
              : ' · 网页第 ' + source.position + ' 条'
            : ''}
        </small>
      </div>
      {assetHref && (
        <a
          className="rw-asset-link"
          href={assetHref}
          aria-label={isEn ? 'View content asset' : '查看内容资产'}
          title={isEn ? 'View content asset' : '查看内容资产'}
        >
          <Library size={16} />
        </a>
      )}
    </li>
  );
}
function Evidence({ projectId, path }: { projectId: string; path: string }) {
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const reqKey = `${projectId}:${path}`;
  const [state, setState] = useState<{
    key: string;
    record: { content: string; format: string } | null;
    error: string;
  }>({ key: '', record: null, error: '' });
  useEffect(() => {
    const controller = new AbortController();
    fetch(
      '/api/geo/evidence?project=' +
        encodeURIComponent(projectId) +
        '&path=' +
        encodeURIComponent(path),
      { signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            isEn
              ? 'This record could not be loaded right now.'
              : '这份记录暂时无法读取。',
          );
        return response.json();
      })
      .then((record) => {
        setState({ key: reqKey, record, error: '' });
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setState({
            key: reqKey,
            record: null,
            error:
              cause instanceof Error
                ? cause.message
                : isEn
                  ? 'This record could not be loaded right now.'
                  : '这份记录暂时无法读取。',
          });
        }
      });
    return () => controller.abort();
  }, [projectId, path, reqKey, isEn]);
  const record = state.key === reqKey ? state.record : null;
  const error = state.key === reqKey ? state.error : '';
  return (
    <section className="rw-evidence" aria-live="polite">
      <details className="rw-file-location">
        <summary>{isEn ? 'Record path' : '记录位置'}</summary>
        <p className="rw-path" data-i18n-skip="">
          {path}
        </p>
      </details>
      {error ? (
        <p role="alert">{error}</p>
      ) : !record ? (
        <p>{isEn ? 'Loading raw text…' : '正在读取原文…'}</p>
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
  onAssets,
  view,
  detailsOnly = false,
  hideHeader = false,
  onEvidence,
  onQuestions,
  onRefresh,
  onImprove,
  projectOptimization,
  activeOptimizationRunId,
  latestShippedAt,
  onPlan,
}: Props) {
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
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
          throw new Error(
            body.error ||
              (isEn ? 'Could not load historical batch.' : '历史批次无法读取。'),
          );
        if (!controller.signal.aborted) setHistoricalBatch(body.batch);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setBatchError(
            error instanceof Error
              ? error.message
              : isEn
                ? 'Could not load historical batch.'
                : '历史批次无法读取。',
          );
      });
    return () => controller.abort();
  }, [requestedBatch, latestBatch.id, latestBatch.projectId, isEn]);
  const defaultLanguage = resolveProjectTargetLanguage(project, batch);
  const progress = overviewProgress(batch, tasks);
  const [filters, setFilters] = useState<ResearchFilter>(() => ({
    ...initialFilters,
    language: resolveProjectTargetLanguage(project, latestBatch),
  }));
  const [query, setQuery] = useState('');
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
          ? isEn
            ? 'This link belongs to another research batch and cannot be replaced with the current batch.'
            : '这条链接属于其他研究批次，不能用本批记录替代。'
          : '',
      );
      const engine = params.get('engine');
      const kind = params.get('kind');
      const result = params.get('result');
      const urlLang = params.get('language');
      const next: ResearchFilter = {
        language: urlLang === 'en' || urlLang === 'zh' ? urlLang : defaultLanguage,
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
      setReadPath(params.get('evidence'));
      if (params.has('batch') && params.get('batch') !== batch.id) {
        setTraceError(batchError);
        setDrawer({
          title:
            batchError ||
            (isEn ? 'Loading historical records…' : '正在读取历史记录…'),
          rows: [],
        });
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
          row.observation?.sources.some((item) =>
            sameCanonicalSource(item.url, source),
          ),
        );
        setDrawer(
          matching.length
            ? {
                title: matching[0].observation!.sources.find((item) =>
                  sameCanonicalSource(item.url, source),
                )!.title,
                rows: matching,
                source,
              }
            : null,
        );
      } else if (params.get('directory') === 'sources') {
        setDrawer({
          title: isEn ? 'All source pages' : '全部来源页面',
          rows,
          directory: true,
        });
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
            isEn
              ? 'Could not find the original observation or source for this link; no substitute record is shown.'
              : '未找到这条链接对应的原始观测或来源，未显示其他记录代替。',
          );
        setDrawer({
          title: next.language === 'zh' ? question.zh || question.en : question.en || question.zh,
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
          title: collectionTitle(next.engine, collection, isEn),
          rows: getResearchRows(batch, { ...next, result: collection }),
          collection,
          engine: next.engine,
        });
      } else if (
        detailsOnly &&
        params.has('batch') &&
        params.get('batch') !== latestBatch.id &&
        !['question', 'source', 'directory', 'collection'].some((key) =>
          params.has(key),
        )
      ) {
        setDrawer({
          title: collectionTitle(next.engine, 'all', isEn),
          rows,
          collection: 'all',
          engine: next.engine,
        });
      } else setDrawer(null);
    };
    readLocation();
    window.addEventListener('popstate', readLocation);
    return () => window.removeEventListener('popstate', readLocation);
  }, [batch, view, detailsOnly, batchError, latestBatch.id, defaultLanguage, isEn]);

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
      if (!returnTo) clearResearchDetailParams(url);
      window.history.replaceState(null, '', url);
      window.dispatchEvent(new PopStateEvent('popstate'));
      return;
    }
    writeLocation(filters);
  }
  const activeLanguage = batch.questions.some((q) =>
    q.observations.some((obs) => obs.language === filters.language),
  )
    ? filters.language
    : defaultLanguage;
  function showDrawer(next: Drawer) {
    const url = new URL(window.location.href);
    clearResearchDetailParams(url);
    if (detailsOnly) {
      url.searchParams.set('batch', batch.id);
      if (returnTo) url.searchParams.set('returnTo', returnTo);
    }
    url.searchParams.set('language', activeLanguage);
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
        language: activeLanguage,
        engine: selectedEngine,
      })
    );
  }
  function searchQuestions(value: string) {
    setQuery(value);
    const url = new URL(window.location.href);
    if (value) url.searchParams.set('search', value);
    else url.searchParams.delete('search');
    url.searchParams.set('questionSearch', value);
    window.history.replaceState(null, '', url);
  }

  const baseRows = getResearchRows(batch, {
    ...filters,
    language: activeLanguage,
    result: 'all',
  });
  function openQuestion(
    question: ResearchQuestion,
    engine?: ResearchRow['engine'],
  ) {
    const selected = engine
      ? { ...filters, language: activeLanguage, engine }
      : { ...filters, language: activeLanguage };
    showDrawer({
      title:
        activeLanguage === 'zh'
          ? question.zh || question.en
          : question.en || question.zh,
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
    const rows = getResearchRows(batch, {
      ...filters,
      language: activeLanguage,
      engine,
      result,
    });
    showDrawer({
      title: collectionTitle(engine, result, isEn),
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
  const pageContent = detailsOnly || view !== 'overview' ? null : (
    <>
      {!hideHeader && (
        <header className="rw-page-heading">
          <div className="rw-heading-title">
            <a
              className="rw-brand"
              href={`/?view=overview&project=${batch.projectId}`}
            >
              <OpenGeoBrandMark size={25} /> OpenGEO
            </a>
            <h1>{isEn ? 'Overview' : '项目概览'}</h1>
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
              aria-label={isEn ? 'Search project questions' : '搜索项目内问题'}
              placeholder={isEn ? 'Search project questions…' : '搜索项目内问题…'}
              value={query}
              onChange={(event) => searchQuestions(event.target.value)}
            />
          </form>
          <button
            className="rw-button"
            onClick={() => onEvidence(batch.reportPath)}
          >
            <FileText size={15} /> {isEn ? 'Research report' : '研究报告'}
          </button>
        </header>
      )}
      <div className="rw-body">
          <ProjectOverview
            projectOptimization={projectOptimization}
            activeOptimizationRunId={activeOptimizationRunId}
            latestShippedAt={latestShippedAt}
            project={project}
            batch={batch}
            filters={filters}
            onFilters={changeFilters}
            onQuestion={openQuestion}
            onPlan={onPlan}
            onQuestions={onQuestions}
            onRefresh={onRefresh}
            onAssets={onAssets}
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
                  {isEn ? `Step ${progress.step}` : `第 ${progress.step} 环`} ·{' '}
                  <span lang={inferContentLang(progress.label)}>
                    {progress.label}
                  </span>{' '}
                  <ChevronDown size={13} />
                </summary>
                <ol
                  className="rw-progress"
                  aria-label={isEn ? '5-step loop progress' : '本轮五环进度'}
                >
                  {progress.steps.map((item, index) => (
                    <li
                      key={item.title}
                      className={index + 1 === progress.step ? 'current' : ''}
                    >
                      <span className="rw-step">{index + 1}</span>
                      <span lang={inferContentLang(item.title)}>
                        {item.title}
                      </span>
                      <span lang={inferContentLang(item.status)}>
                        {item.status}
                      </span>
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
                <button onClick={closeDrawer}>
                  {isEn ? '← Back to prompts' : '← 返回问题列表'}
                </button>
              ) : (
                <span>
                  {readPath
                    ? (isEn ? 'Raw record' : '原始记录')
                    : drawer.question
                      ? (isEn ? 'Question detail' : '问题详情')
                      : (isEn ? 'Observations' : '观测记录')}
                </span>
              )}
              <button aria-label={isEn ? 'Close detail' : '关闭详情'} onClick={closeDrawer} autoFocus>
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
                  {isEn ? '← Back to source' : '← 返回来源位置'}
                </a>
              )}
              {traceError && <p role="alert">{traceError}</p>}
              <div className="rw-detail-title">
                <h2
                  id="rw-detail-title"
                  className={
                    drawer.question && !readPath && drawer.rows.length
                      ? 'rw-reading-title'
                      : undefined
                  }
                  lang={drawer.question ? filters.language : undefined}
                  data-i18n-skip={drawer.source ? '' : undefined}
                >
                  {drawer.title}
                </h2>
                <p>
                  {view === 'overview' || drawer.question
                    ? overviewObservationDates(drawer.rows, isEn)
                    : (batch.updatedAt || batch.date).slice(0, 10)}{' '}
                  ·{' '}
                  {filters.language === 'zh'
                    ? isEn
                      ? 'Chinese query'
                      : '中文问法'
                    : isEn
                      ? 'English query'
                      : '英文问法'}{' '}
                  ·{' '}
                  {drawer.directory
                    ? isEn
                      ? plural(uiLanguage, sources.length, {
                          one: `${sources.length} source page`,
                          other: `${sources.length} source pages`,
                        })
                      : `${sources.length} 个来源页面`
                    : (() => {
                        const count = drawer.rows.filter((row) => row.observation).length;
                        return isEn
                          ? showingHistory
                            ? plural(uiLanguage, count, {
                                one: `${count} historical record`,
                                other: `${count} historical records`,
                              })
                            : plural(uiLanguage, count, {
                                one: `${count} record`,
                                other: `${count} records`,
                              })
                          : `${count}${showingHistory ? ' 条历史记录' : ' 条记录'}`;
                      })()}
                </p>
                {drawer.question && (
                  <div
                    className="rw-history-switch"
                    role="group"
                    aria-label={isEn ? 'Record scope' : '记录范围'}
                  >
                    <button
                      aria-pressed={!showingHistory}
                      onClick={() => showQuestionHistory(false)}
                    >
                      {isEn ? 'Latest' : '最新回答'}
                    </button>
                    <button
                      aria-pressed={showingHistory}
                      onClick={() => showQuestionHistory(true)}
                    >
                      {isEn ? 'History' : '历史回答'}
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
                    {isEn ? 'Open source page' : '打开来源页面'}{' '}
                    <ArrowUpRight size={14} />
                  </a>
                  {drawer.rows[0] &&
                    isConsumerResearchEngine(drawer.rows[0].engine) && (
                      <a
                        className="rw-button"
                        href={assetHref(drawer.source, drawer.rows[0].engine)}
                      >
                        <Library size={14} />{' '}
                        {isEn ? 'View content asset' : '查看内容资产'}
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
                    {isEn ? '← Back to details' : '← 返回详情'}
                  </button>
                  <Evidence projectId={batch.projectId} path={readPath} />
                </>
              ) : drawer.directory ? (
                <div className="rw-source-directory">
                  <div className="rw-source-columns">
                    <span>{isEn ? 'Source page' : '来源页面'}</span>
                    <span>{isEn ? 'Records' : '记录数'}</span>
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
                        <strong data-i18n-skip="">{source.title}</strong>
                        <small>
                          <span data-i18n-skip="">
                            {safeUrl(source.url)?.hostname}
                          </span>{' '}
                          · {isEn ? kinds[source.kind].en : kinds[source.kind].zh}
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
                        <span>{isEn ? 'Run record' : '执行记录'}</span>
                        <span>
                          {view === 'overview' &&
                          drawer.rows.every(isAiAnswerRow)
                            ? isEn
                              ? 'Mentioned in answer'
                              : '正文提及'
                            : isEn
                              ? 'Official source'
                              : '官方来源'}
                        </span>
                        <span>{isEn ? 'Sources' : '来源数'}</span>
                      </div>
                    )}
                    {!drawer.rows.length && (
                      <div className="rw-empty">
                        {drawer.question
                          ? isEn
                            ? 'No search records for this question yet.'
                            : '这道题尚无搜索记录。'
                          : isEn
                            ? 'No records match this filter. Return to Overview to see all measured results.'
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
                                ? isAiAnswerRow(row)
                                  ? (isEn ? 'AI Overview' : 'AI 概览')
                                  : (isEn ? 'Web Search' : '网页搜索')
                                : (isEn ? 'AI Answer' : 'AI 回答')}
                            </span>
                          </span>
                          {view === 'overview' && isAiAnswerRow(row) ? (
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
                                ? (isEn ? 'Not captured' : '尚未搜索')
                                : row.observation.status === 'found'
                                  ? (isEn ? 'Has official source' : '含官方来源')
                                  : (isEn ? 'No official source' : '未见官方来源')}
                            </span>
                          ) : (
                            <Status rows={[row]} />
                          )}
                          <span className="rw-record-count">
                            {row.observation?.sources.length ?? '—'} {isEn ? 'sources' : '个来源'}
                          </span>
                          <ChevronDown size={15} />
                          <span className="rw-record-preview">
                            {!drawer.question
                              ? (filters.language === 'zh'
                                  ? row.question.zh
                                  : row.question.en) + ' · '
                              : ''}
                            {row.observation ? (
                              <span
                                lang={inferContentLang(row.observation.summary)}
                              >
                                {view === 'overview'
                                  ? row.observation.summary.replace(
                                      /^(完整可见正文未观察到我方提及及官方来源。|正文提及并给出我方官方来源。)/,
                                      '',
                                    )
                                  : row.observation.summary}
                              </span>
                            ) : isEn ? (
                              'No observation recorded for this platform yet'
                            ) : (
                              '尚无该入口的观测记录'
                            )}
                          </span>
                        </summary>
                        <div
                          className={
                            'rw-answer-body' +
                            (drawer.question
                              ? ' rw-question-reading' +
                                (isAiAnswerRow(row)
                                  ? ' rw-answer-reading'
                                  : ' rw-search-reading')
                              : '')
                          }
                        >
                          {drawer.question && isAiAnswerRow(row) && (
                            <AnswerText
                              key={row.key}
                              projectId={batch.projectId}
                              path={row.observation?.answerPath}
                              contentLang={row.observation?.language}
                              projectNames={projectNames.filter((name): name is string => Boolean(name))}
                            />
                          )}
                          {drawer.question && (
                            <div className="rw-prompt">
                              <h3>
                                {row.observation
                                  ? (isEn ? 'Prompt' : '本次问法')
                                  : (isEn ? 'Pending query' : '待搜索问题')}
                              </h3>
                              <p lang={row.observation?.language ?? filters.language}>
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
                            <p className="rw-answer-question" lang={filters.language}>
                              {filters.language === 'zh'
                                ? row.question.zh
                                : row.question.en}
                            </p>
                          )}
                          {row.observation ? (
                            <>
                              {!drawer.question && (
                                <>
                                  <p
                                    className="rw-summary"
                                    lang={
                                      /[\p{Script=Han}]/u.test(row.observation.summary)
                                        ? 'zh'
                                        : 'en'
                                    }
                                  >
                                    {row.observation.summary}
                                  </p>
                                  {row.observation.overviewStatus && (
                                    <p className="rw-overview-state">
                                      {isEn ? 'Google AI Overview: ' : 'Google AI 概览：'}
                                      {(
                                        {
                                          generated: isEn ? 'Generated' : '已生成',
                                          generation_failed: isEn
                                            ? 'Generation failed'
                                            : '生成失败',
                                          not_shown: isEn ? 'Not shown' : '未显示',
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
                                    {isAiAnswerRow(row)
                                      ? (isEn ? 'Full answer' : '完整回答')
                                      : (isEn ? 'Full search log' : '完整搜索记录')}{' '}
                                    <ArrowRight size={14} />
                                  </button>
                                )}
                                <button
                                  className="rw-muted-link"
                                  onClick={() =>
                                    readEvidence(row.observation!.evidencePath)
                                  }
                                >
                                  {isEn ? 'Raw record' : '原始记录'} <FileText size={13} />
                                </button>
                              </footer>
                              {(row.observation.sources.length > 0 ||
                                (drawer.question && !isAiAnswerRow(row))) && (
                                <details
                                  className="rw-record-sources"
                                  open={
                                    !!drawer.question && !isAiAnswerRow(row)
                                  }
                                >
                                  <summary>
                                    {isAiAnswerRow(row)
                                      ? (isEn ? 'Cited sources' : '引用网页')
                                      : (isEn ? 'Search results' : '搜索结果')}{' '}
                                    <span>
                                      {row.observation.sources.length}
                                    </span>
                                    <ChevronDown size={14} />
                                  </summary>
                                  {drawer.question &&
                                    row.engine === 'google' &&
                                    !isAiAnswerRow(row) &&
                                    row.observation.overviewStatus && (
                                      <p className="rw-overview-state">
                                        {row.observation.overviewStatus ===
                                        'generation_failed'
                                          ? isEn
                                            ? 'AI Overview failed to generate'
                                            : '本次 AI 概览生成失败'
                                          : row.observation.overviewStatus ===
                                              'not_shown'
                                            ? isEn
                                              ? 'AI Overview not shown'
                                              : '本次未显示 AI 概览'
                                            : isEn
                                              ? 'AI Overview generated · Web results below'
                                              : '本次已生成 AI 概览 · 下方为网页结果'}
                                      </p>
                                    )}
                                  {!row.observation.sources.length && (
                                    <p className="rw-answer-placeholder">
                                      {isEn
                                        ? 'No web results returned in this run.'
                                        : '本次没有返回网页结果。'}
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
                                          {isEn
                                            ? `${row.observation.sources.length - 3} more sources `
                                            : `其余 ${row.observation.sources.length - 3} 个来源 `}
                                          <ChevronDown size={13} />
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
                                    ? (isEn ? 'Query details & timestamp' : '搜索条件与时间')
                                    : (isEn ? 'Prompt, conditions & timestamp' : '原始问法、条件与时间')}{' '}
                                  <ChevronDown size={13} />
                                </summary>
                                {!drawer.question && (
                                  <p lang={row.observation.language}>
                                    {row.observation.query}
                                  </p>
                                )}
                                <p
                                  data-i18n-skip=""
                                  lang={
                                    row.observation.conditions
                                      ? inferContentLang(row.observation.conditions)
                                      : undefined
                                  }
                                >
                                  {row.observation.conditions}
                                </p>
                                <p>{row.observation.recordedAt}</p>
                              </details>
                            </>
                          ) : (
                            <p className="rw-summary">
                              {statusText(row, isEn)} ·{' '}
                              {isEn
                                ? 'No observation recorded for this language and platform.'
                                : '没有该语言与入口的观察记录。'}
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

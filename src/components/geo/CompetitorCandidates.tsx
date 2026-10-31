'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Bookmark,
  Check,
  ChevronDown,
  X,
} from 'lucide-react';
import type {
  CandidateQuestion as CandidateEvidence,
  CompetitorCandidate as Candidate,
  CompetitorCandidates as CandidateResponse,
  CompetitorMatch,
  CompetitorRow,
  CompetitorTarget,
} from '@/lib/geo/competitor-types';
import type { ResearchEngine } from '@/lib/geo/research-types';
import {
  RESEARCH_ENGINES,
  RESEARCH_ENGINE_NAMES,
  isResearchEngine,
} from '@/lib/geo/research-engines';
import {
  isCompetitorAnswerRow,
  latestCompetitorRows,
} from '@/lib/geo/competitor-metrics';
import GeoSelect from './GeoSelect';
import CompetitorExperience from './CompetitorExperience';
import CompetitorPerformance from './CompetitorPerformance';
import './competitor-candidates.css';

type Props = {
  projectId: string;
  batchId?: string;
  questionId?: string;
  language?: 'zh' | 'en';
  engine?: ResearchEngine | 'all';
  compact?: boolean;
  revision?: string;
  onSelected?: () => void;
  presentation?: 'overview' | 'workspace';
  onOpen?: () => void;
};

function matchLabel(match: CompetitorMatch) {
  return match.status === 'matched'
    ? '已提及'
    : match.status === 'not_seen'
      ? '未提及'
      : '待核实';
}

function isTarget(
  candidate: Candidate,
  target: CompetitorTarget | null | undefined,
) {
  if (!target) return false;
  const normalize = (value: string) => {
    try {
      const url = new URL(value);
      return `${url.hostname.toLocaleLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
    } catch {
      return value.trim().replace(/\/+$/, '');
    }
  };
  const urls = new Set(target.officialUrls.map(normalize));
  return candidate.officialUrls.some((url) => urls.has(normalize(url)));
}

export default function CompetitorCandidates({
  projectId,
  batchId,
  questionId,
  language,
  engine,
  compact = false,
  revision: dataRevision,
  onSelected,
  presentation,
  onOpen,
}: Props) {
  const filterEngine = engine === 'all' ? undefined : engine;
  const candidateContext = questionId || 'project';
  const analysisContext = `${projectId}:${batchId || ''}:${dataRevision || ''}:${language || 'zh'}:${engine || 'all'}`;
  const [data, setData] = useState<CandidateResponse | null>(null);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<CandidateResponse | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [previewLanguage, setPreviewLanguage] = useState<'zh' | 'en'>(
    language || 'zh',
  );
  const [previewEngine, setPreviewEngine] = useState<ResearchEngine>(
    filterEngine || 'chatgpt',
  );
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [readAttempt, setReadAttempt] = useState(0);
  const [analysisState, setAnalysisState] = useState({
    context: analysisContext,
    pending: false,
    error: '',
  });
  const analyzing =
    analysisState.context === analysisContext && analysisState.pending;
  const analysisError =
    analysisState.context === analysisContext ? analysisState.error : '';
  const activeAnalysisContext = useRef<string | null>(null);
  const submittingAnalysis = useRef<{
    context: string;
    request: number;
    startedAt: number;
  } | null>(null);
  const analysisRequest = useRef(0);

  useEffect(() => {
    ++analysisRequest.current;
    activeAnalysisContext.current = analysisContext;
    return () => {
      activeAnalysisContext.current = null;
    };
  }, [analysisContext]);
  const dialog = useRef<HTMLDialogElement>(null);
  const dialogTitle = useId();
  const revision = useRef(0);

  const endpoint = useCallback(
    (candidateId?: string) => {
      const params = new URLSearchParams({
        project: projectId,
        language: language || 'zh',
        engine: engine || 'all',
      });
      if (batchId) params.set('batch', batchId);
      if (candidateId) params.set('candidate', candidateId);
      return `/api/geo/competitor-candidates?${params}`;
    },
    [projectId, batchId, language, engine],
  );

  useEffect(() => {
    setData(null);
    setError('');
    setSelectedId(null);
    setMessage('');
    setPending(null);
  }, [endpoint, projectId]);

  useEffect(() => {
    let disposed = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    const controllers = new Set<AbortController>();
    async function read() {
      if (disposed) return;
      clearTimeout(poll);
      const request = ++revision.current;
      const controller = new AbortController();
      controllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(endpoint(), { signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '候选读取失败。');
        if (
          result.projectId !== projectId ||
          (batchId && result.batch?.id !== batchId)
        )
          throw new Error('返回的项目或批次不匹配，请重新读取。');
        if (!disposed && request === revision.current) {
          setData(result);
          setError('');
          const submission = submittingAnalysis.current;
          const terminal = ['ready', 'failed'].includes(
            result.analysis?.status,
          );
          const resultStartedAt = Date.parse(
            result.analysis?.startedAt || result.analysis?.generatedAt || '',
          );
          const submissionFinished = !!(
            submission &&
            submission.context === analysisContext &&
            submission.request === analysisRequest.current &&
            terminal &&
            resultStartedAt >= submission.startedAt
          );
          if (submissionFinished) {
            submittingAnalysis.current = null;
            ++analysisRequest.current;
            setAnalysisState({
              context: analysisContext,
              pending: false,
              error: '',
            });
          }
          if (result.analysis?.status === 'ready' && !result.analysis.stale)
            setAnalysisState((current) =>
              current.error ? { ...current, error: '' } : current,
            );
          if (
            result.analysis?.status === 'running' ||
            (analyzing && !submissionFinished)
          )
            poll = setTimeout(() => void read(), 2_500);
        }
      } catch (cause) {
        if (!disposed && request === revision.current)
          setError(
            controller.signal.aborted
              ? '读取超时，请重新读取。'
              : cause instanceof Error
                ? cause.message
                : '候选读取失败。',
          );
      } finally {
        clearTimeout(timeout);
        controllers.delete(controller);
      }
    }
    function changed(event: Event) {
      if (
        (event as CustomEvent<{ projectId?: string }>).detail?.projectId ===
        projectId
      )
        void read();
    }
    void read();
    window.addEventListener('geo-competitor-changed', changed);
    return () => {
      disposed = true;
      clearTimeout(poll);
      controllers.forEach((controller) => controller.abort());
      window.removeEventListener('geo-competitor-changed', changed);
    };
  }, [
    endpoint,
    projectId,
    batchId,
    dataRevision,
    analyzing,
    readAttempt,
    analysisContext,
  ]);

  const analyze = useCallback(
    async (force = false) => {
      if (
        analyzing ||
        submittingAnalysis.current?.context === analysisContext ||
        data?.analysis.status === 'running' ||
        activeAnalysisContext.current !== analysisContext
      )
        return;
      const request = ++analysisRequest.current;
      submittingAnalysis.current = {
        context: analysisContext,
        request,
        startedAt: Date.now(),
      };
      const isCurrent = () =>
        activeAnalysisContext.current === analysisContext &&
        request === analysisRequest.current;
      setAnalysisState({ context: analysisContext, pending: true, error: '' });
      setError('');
      let analysisFailure = '';
      try {
        const response = await fetch('/api/geo/competitor-candidates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            action: 'analyze',
            language: language || 'zh',
            engine: engine || 'all',
            ...(batchId ? { batchId } : {}),
            ...(force ? { force: true } : {}),
          }),
        });
        const result = await response.json();
        if (!isCurrent()) return;
        if (!response.ok) throw new Error(result.error || '竞品分析失败。');
        if (
          result.projectId !== projectId ||
          (batchId && result.batch?.id !== batchId)
        )
          throw new Error('返回的项目或批次不匹配，请重试。');
        ++revision.current;
        setData(result);
        if (result.analysis?.status === 'failed')
          analysisFailure = result.analysis.error || '竞品分析失败。';
      } catch (cause) {
        if (isCurrent())
          analysisFailure =
            cause instanceof Error ? cause.message : '竞品分析失败。';
      } finally {
        if (submittingAnalysis.current?.request === request)
          submittingAnalysis.current = null;
        if (isCurrent())
          setAnalysisState({
            context: analysisContext,
            pending: false,
            error: analysisFailure,
          });
      }
    },
    [
      projectId,
      batchId,
      language,
      engine,
      analyzing,
      analysisContext,
      data?.analysis.status,
    ],
  );

  useEffect(() => {
    if (!data) return;
    function readLocation() {
      const params = new URLSearchParams(window.location.search);
      if ((params.get('candidateContext') || 'project') !== candidateContext)
        return;
      const candidateId = params.get('candidate');
      if (!candidateId) {
        setSelectedId(null);
        return;
      }
      setSelectedId(candidateId);
      const requestedLanguage = params.get('candidateLanguage');
      setPreviewLanguage(
        requestedLanguage === 'en' || requestedLanguage === 'zh'
          ? requestedLanguage
          : language || 'zh',
      );
      const requestedEngine = params.get('candidateEngine');
      setPreviewEngine(
        isResearchEngine(requestedEngine)
          ? requestedEngine
          : filterEngine || 'chatgpt',
      );
    }
    readLocation();
    window.addEventListener('popstate', readLocation);
    return () => window.removeEventListener('popstate', readLocation);
  }, [data, language, filterEngine, candidateContext]);

  useEffect(() => {
    setPreview(null);
    setPreviewError('');
    if (!selectedId) return;
    const controller = new AbortController();
    fetch(endpoint(selectedId), { signal: controller.signal })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '对照预览读取失败。');
        if (!controller.signal.aborted && result.projectId === projectId)
          setPreview(result);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setPreviewError(
            cause instanceof Error ? cause.message : '对照预览读取失败。',
          );
      });
    return () => controller.abort();
  }, [selectedId, endpoint, projectId]);

  useEffect(() => {
    if (selectedId && !dialog.current?.open) dialog.current?.showModal();
    if (!selectedId && dialog.current?.open) dialog.current.close();
  }, [selectedId]);

  function updatePreviewLocation(
    candidateId: string | null,
    nextLanguage = previewLanguage,
    nextEngine = previewEngine,
  ) {
    const url = new URL(window.location.href);
    for (const key of [
      'candidate',
      'candidateLanguage',
      'candidateEngine',
      'candidateContext',
    ])
      url.searchParams.delete(key);
    if (candidateId) {
      url.searchParams.set('candidate', candidateId);
      url.searchParams.set('candidateContext', candidateContext);
      url.searchParams.set('candidateLanguage', nextLanguage);
      url.searchParams.set('candidateEngine', nextEngine);
    }
    window.history.replaceState(window.history.state, '', url);
  }

  function openCandidate(candidate: Candidate) {
    const evidence =
      candidate.questions.find(
        (item) =>
          (!language || item.language === language) &&
          (!filterEngine || item.engine === filterEngine),
      ) || candidate.questions[0];
    const nextLanguage = language || evidence?.language || 'zh';
    const nextEngine = filterEngine || evidence?.engine || 'chatgpt';
    setPreviewLanguage(nextLanguage);
    setPreviewEngine(nextEngine);
    setSelectedId(candidate.id);
    setMessage('');
    updatePreviewLocation(candidate.id, nextLanguage, nextEngine);
  }

  function closePreview() {
    setSelectedId(null);
    updatePreviewLocation(null);
  }

  async function auditCitations() {
    if (pending) return;
    const context = analysisContext;
    const isCurrent = () => activeAnalysisContext.current === context;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    setPending('citations');
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/geo/competitor-candidates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          projectId,
          batchId,
          action: 'audit-citations',
          language: language || 'zh',
          engine: engine || 'all',
        }),
      });
      const result = await response.json();
      if (!isCurrent()) return;
      if (!response.ok) throw new Error(result.error || '引用核实失败。');
      if (
        result.projectId !== projectId ||
        (batchId && result.batch?.id !== batchId)
      )
        throw new Error('返回的项目或批次不匹配，请重试。');
      ++revision.current;
      setData(result);
      setMessage(
        '已核对保存的引用。缺少完整来源的记录会保留原因，不能算作零。',
      );
      window.dispatchEvent(
        new CustomEvent('geo-competitor-changed', { detail: { projectId } }),
      );
    } catch (cause) {
      if (isCurrent())
        setError(
          controller.signal.aborted
            ? '引用读取超时，请重试。'
            : cause instanceof Error
              ? cause.message
              : '引用核实失败。',
        );
    } finally {
      clearTimeout(timeout);
      if (isCurrent()) setPending(null);
    }
  }

  async function act(
    candidate: Candidate,
    action: 'save' | 'unsave' | 'select',
  ) {
    if (pending) return;
    const actionContext = analysisContext;
    const isCurrent = () => activeAnalysisContext.current === actionContext;
    setPending(candidate.id);
    setError('');
    setPreviewError('');
    setMessage('');
    try {
      const response = await fetch('/api/geo/competitor-candidates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          candidateId: candidate.id,
          action,
          language: language || 'zh',
          engine: engine || 'all',
          ...(batchId ? { batchId } : {}),
        }),
      });
      const result = await response.json();
      if (!isCurrent()) return;
      if (!response.ok) throw new Error(result.error || '保存失败。');
      if (result.projectId !== projectId)
        throw new Error('返回的项目不匹配，请重试。');
      ++revision.current;
      setData(result);
      setMessage(
        action === 'select'
          ? `已将 ${candidate.name} 设为主要对标。`
          : action === 'save'
            ? `已关注 ${candidate.name}。`
            : `已取消关注 ${candidate.name}。`,
      );
      window.dispatchEvent(
        new CustomEvent('geo-competitor-changed', { detail: { projectId } }),
      );
      if (action === 'select') {
        closePreview();
        onSelected?.();
      }
    } catch (cause) {
      if (!isCurrent()) return;
      const detail = cause instanceof Error ? cause.message : '保存失败。';
      if (selectedId) setPreviewError(detail);
      else setError(detail);
    } finally {
      if (isCurrent()) setPending(null);
    }
  }

  function recordHref(
    record: CandidateEvidence | CompetitorRow,
    answers: boolean,
  ) {
    const activeBatch =
      ('batchId' in record ? record.batchId : undefined) ||
      preview?.batch?.id ||
      data?.batch?.id ||
      batchId;
    const current = new URL(window.location.href);
    current.searchParams.delete('returnTo');
    if (selectedId) {
      current.searchParams.set('candidate', selectedId);
      current.searchParams.set('candidateContext', candidateContext);
      current.searchParams.set('candidateLanguage', previewLanguage);
      current.searchParams.set('candidateEngine', previewEngine);
    }
    const params = new URLSearchParams({
      view: 'questions',
      project: projectId,
      question: record.questionId,
      language: record.language,
      engine: record.engine,
      returnTo: `${current.pathname}${current.search}`,
    });
    if (activeBatch) params.set('batch', activeBatch);
    if (answers) {
      params.set('detail', 'answers');
      if (activeBatch)
        params.set(
          'record',
          `${activeBatch}:${record.questionId}:${record.engine}:${record.language}:${record.observationIndex}`,
        );
    }
    return `/?${params}`;
  }

  const candidates = (data?.candidates || []).filter(
    (candidate) =>
      !!presentation ||
      (!questionId && !language && !filterEngine) ||
      candidate.questions.some(
        (item) =>
          (!questionId || item.questionId === questionId) &&
          (!language || item.language === language) &&
          (!filterEngine || item.engine === filterEngine),
      ),
  );
  const visibleCandidates = candidates;
  const selected =
    preview?.previewCandidate ||
    data?.candidates.find((candidate) => candidate.id === selectedId) ||
    (data?.selectedCandidate?.id === selectedId
      ? data.selectedCandidate
      : undefined);
  const comparison = preview?.comparison;
  const scopedRows =
    comparison?.rows.filter(
      (row) => row.language === previewLanguage && row.engine === previewEngine,
    ) || [];
  const rows = latestCompetitorRows(scopedRows);
  const hasAnswerRows = scopedRows.some(isCompetitorAnswerRow);
  const evidence =
    selected?.questions.filter(
      (item) =>
        item.language === previewLanguage && item.engine === previewEngine,
    ) || [];
  const engineOptions = RESEARCH_ENGINES.filter(
    (item) =>
      item === previewEngine ||
      comparison?.rows.some((row) => row.engine === item) ||
      selected?.questions.some((record) => record.engine === item),
  ).map((item) => ({ value: item, label: RESEARCH_ENGINE_NAMES[item] }));

  return (
    <section
      className={`cc-candidates${compact ? ' is-compact' : ''}`}
      aria-label="竞品候选"
    >
      {presentation ? (
        <>
          {error && (
            <div className="cc-read-error" role="alert">
              <p className="cc-error">{error}</p>
              <button
                type="button"
                className="cc-button"
                onClick={() => {
                  setError('');
                  setReadAttempt((value) => value + 1);
                }}
              >
                重新读取
              </button>
            </div>
          )}
          {!data && !error && <p className="cc-empty">正在读取竞品分析…</p>}
          {data && (
            <CompetitorExperience
              data={data}
              comparison={data.comparison}
              presentation={presentation}
              language={language || 'zh'}
              engine={engine || 'all'}
              analyzing={analyzing}
              analysisError={analysisError}
              readError={!!error}
              pending={pending}
              onAnalyze={() => void analyze(true)}
              onPreview={openCandidate}
              onSelect={(candidate) => void act(candidate, 'select')}
              onOpen={onOpen}
            />
          )}
          {presentation === 'workspace' && data && (
            <details className="cc-citation-review cx-learning">
              <summary>
                引用核实 <ChevronDown size={12} />
              </summary>
              <button
                type="button"
                className="cc-button"
                disabled={!!pending || analyzing}
                onClick={() => void auditCitations()}
              >
                {pending === 'citations'
                  ? '正在核对已保存引用…'
                  : '核实已有引用'}
              </button>
              {message && (
                <p className="cc-message" role="status">
                  {message}
                </p>
              )}
            </details>
          )}
        </>
      ) : (
        <>
          <div className="cc-heading">
            <h2>
              {questionId ? '本题发现的竞品' : '竞品候选'}
              {data && <span>{candidates.length}</span>}
            </h2>
            {compact && (
              <a
                href={`/?${new URLSearchParams({ view: 'competitor', project: projectId, ...(batchId ? { batch: batchId } : {}) })}`}
              >
                全部候选
                <ArrowRight size={13} />
              </a>
            )}
          </div>
          {error && (
            <div className="cc-read-error" role="alert">
              <p className="cc-error">{error}</p>
              <button
                type="button"
                className="cc-button"
                onClick={() => {
                  setError('');
                  setReadAttempt((value) => value + 1);
                }}
              >
                重新读取
              </button>
            </div>
          )}
          {message && !selectedId && (
            <p className="cc-message" role="status">
              {message}
            </p>
          )}
          {!data && !error && (
            <p className="cc-empty">正在读取已有搜索中的候选…</p>
          )}
          {data && !candidates.length && (
            <p className="cc-empty">
              {questionId
                ? '这道题的已有结果中还没有可展示的竞品候选。'
                : '已有搜索结果中还没有可展示的竞品候选。'}
            </p>
          )}
          <div className="cc-list">
            {visibleCandidates.map((candidate) => (
              <article key={candidate.id} className="cc-candidate">
                <div className="cc-candidate-main">
                  <div className="cc-candidate-title">
                    <button
                      type="button"
                      onClick={() => openCandidate(candidate)}
                    >
                      {candidate.name}
                    </button>
                    {isTarget(candidate, data?.target) && (
                      <span className="cc-target">
                        <Check size={11} />
                        主要对标
                      </span>
                    )}
                  </div>
                  <p>
                    {candidate.analysis?.description ||
                      candidate.description ||
                      candidate.reason}
                  </p>
                  <span className="cc-evidence-count">
                    {
                      new Set(
                        candidate.questions.map((item) => item.questionId),
                      ).size
                    }{' '}
                    道关联问题 · {candidate.questions.length} 条发现依据
                  </span>
                </div>
                <div className="cc-actions">
                  <button
                    type="button"
                    className={`cc-save${candidate.saved ? ' is-saved' : ''}`}
                    disabled={!!pending}
                    onClick={() =>
                      void act(candidate, candidate.saved ? 'unsave' : 'save')
                    }
                    aria-label={`${candidate.saved ? '取消关注' : '关注'} ${candidate.name}`}
                  >
                    <Bookmark
                      size={14}
                      fill={candidate.saved ? 'currentColor' : 'none'}
                    />
                    {candidate.saved ? '已关注' : '关注'}
                  </button>
                  <button
                    type="button"
                    className="cc-button"
                    onClick={() => openCandidate(candidate)}
                  >
                    查看对照
                    <ArrowRight size={13} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
      <dialog
        ref={dialog}
        className="cc-dialog"
        aria-labelledby={dialogTitle}
        onCancel={closePreview}
        onClose={closePreview}
        onClick={(event) => {
          if (event.target === event.currentTarget) closePreview();
        }}
      >
        {!selected && (
          <article>
            <header className="cc-dialog-heading">
              <div>
                <h2 id={dialogTitle}>候选对照</h2>
                <p role={previewError ? 'alert' : 'status'}>
                  {previewError || '正在读取候选资料…'}
                </p>
              </div>
              <button
                type="button"
                className="cc-close"
                aria-label="关闭候选对照"
                onClick={closePreview}
              >
                <X size={20} />
              </button>
            </header>
          </article>
        )}
        {selected && (
          <article>
            <header className="cc-dialog-heading">
              <div>
                <span>候选对照</span>
                <h2 id={dialogTitle}>{selected.name}</h2>
                <p>{selected.analysis?.description || selected.description}</p>
              </div>
              <button
                type="button"
                className="cc-close"
                aria-label="关闭候选对照"
                onClick={closePreview}
              >
                <X size={20} />
              </button>
            </header>
            <div className="cc-dialog-body">
              <div className="cc-preview-actions">
                <button
                  className={`cc-button${selected.saved ? ' is-saved' : ''}`}
                  type="button"
                  disabled={!!pending}
                  onClick={() =>
                    void act(selected, selected.saved ? 'unsave' : 'save')
                  }
                >
                  <Bookmark
                    size={14}
                    fill={selected.saved ? 'currentColor' : 'none'}
                  />
                  {selected.saved ? '已关注' : '关注候选'}
                </button>
                <button
                  className="cc-button primary"
                  type="button"
                  disabled={!!pending || isTarget(selected, data?.target)}
                  onClick={() => void act(selected, 'select')}
                >
                  {pending === selected.id
                    ? '保存中…'
                    : isTarget(selected, data?.target)
                      ? '当前参照竞品'
                      : '以它为参照'}
                </button>
              </div>
              {previewError && (
                <p className="cc-error" role="alert">
                  {previewError}
                </p>
              )}
              {message && (
                <p className="cc-message" role="status">
                  {message}
                </p>
              )}
              <p className="cc-reason">
                {selected.analysis?.reason || selected.reason}
              </p>
              <div className="cc-preview-filters">
                <GeoSelect
                  label="候选预览语言"
                  value={previewLanguage}
                  onChange={(value) => {
                    setPreviewLanguage(value);
                    updatePreviewLocation(selected.id, value, previewEngine);
                  }}
                  options={[
                    { value: 'zh', label: '中文' },
                    { value: 'en', label: 'English' },
                  ]}
                  portalTarget={dialog}
                />
                <GeoSelect
                  label="候选预览平台"
                  value={previewEngine}
                  onChange={(value) => {
                    setPreviewEngine(value);
                    updatePreviewLocation(selected.id, previewLanguage, value);
                  }}
                  options={engineOptions}
                  portalTarget={dialog}
                />
                <span>{preview?.batch?.date || data?.batch?.date}</span>
              </div>
              {!preview && !previewError && (
                <p className="cc-empty">正在读取同题对照…</p>
              )}
              {comparison && (
                <>
                  <CompetitorPerformance
                    performance={comparison.performance}
                    ownName={comparison.own.name}
                    targetName={selected.name}
                    language={previewLanguage}
                    engine={previewEngine}
                  />
                  <div className="cc-subheading">
                    <h3>{hasAnswerRows ? '同题回答记录' : '同题网页记录'}</h3>
                    <span>{rows.length} 条</span>
                  </div>
                  {rows.length ? (
                    <div className="cc-records">
                      {rows.map((row) => (
                        <article key={row.id}>
                          <div className="cc-record-title">
                            <a href={recordHref(row, false)}>{row.question}</a>
                            <a
                              className="cc-answer-link"
                              href={recordHref(row, true)}
                            >
                              {isCompetitorAnswerRow(row)
                                ? '原回答'
                                : '查看来源'}
                              <ArrowUpRight size={12} />
                            </a>
                          </div>
                          {hasAnswerRows && (
                            <div className="cc-match-pair">
                              <span className={row.ownMention.status}>
                                {comparison.own.name}：
                                {matchLabel(row.ownMention)}
                              </span>
                              <span className={row.targetMention.status}>
                                {selected.name}：{matchLabel(row.targetMention)}
                              </span>
                            </div>
                          )}
                          {row.targetMention.excerpts.length > 0 && (
                            <blockquote>
                              {row.targetMention.excerpts[0]}
                            </blockquote>
                          )}
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="cc-empty">当前平台与语言暂无同题记录。</p>
                  )}
                </>
              )}
              <details className="cc-evidence" open={!hasAnswerRows}>
                <summary>候选发现依据 · {evidence.length} 条</summary>
                {evidence.length ? (
                  evidence.map((item, index) => (
                    <article
                      key={`${item.questionId}:${item.observationIndex}:${index}`}
                    >
                      <a href={recordHref(item, true)}>
                        {item.question}
                        <ArrowUpRight size={12} />
                      </a>
                      <blockquote>{item.excerpt}</blockquote>
                      {item.sourceUrl && (
                        <a
                          className="cc-source"
                          href={item.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {item.sourceUrl}
                          <ArrowUpRight size={11} />
                        </a>
                      )}
                      <small>{item.recordedAt}</small>
                    </article>
                  ))
                ) : (
                  <p className="cc-empty">当前筛选下没有候选发现记录。</p>
                )}
              </details>
              {selected.officialUrls.length > 0 && (
                <details className="cc-identities">
                  <summary>名称与官方入口</summary>
                  {selected.aliases.length > 0 && (
                    <p>{selected.aliases.join('、')}</p>
                  )}
                  {selected.officialUrls.map((url) => (
                    <a href={url} key={url} target="_blank" rel="noreferrer">
                      {url}
                      <ArrowUpRight size={12} />
                    </a>
                  ))}
                </details>
              )}
            </div>
          </article>
        )}
      </dialog>
    </section>
  );
}

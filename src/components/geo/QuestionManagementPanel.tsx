'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  Minus,
  Plus,
  Search,
  X,
} from 'lucide-react';
import ResearchEngineIcon from './ResearchEngineIcon';
import type { GeoState } from '@/lib/geo/types';
import type {
  QuestionCandidate,
  QuestionCategory,
  QuestionDecision,
} from '@/lib/geo/question-types';
import type {
  ResearchBatch,
  ResearchQuestion,
  ResearchEngine,
} from '@/lib/geo/research-types';
import {
  RESEARCH_ENGINE_NAMES,
  RESEARCH_ENGINES,
  getBatchResearchEngines,
  isResearchEngine,
} from '@/lib/geo/research-engines';
import { resolveProjectTargetLanguage } from '@/lib/geo/i18n';
import {
  getLatestResearchObservation,
  getResearchRows,
  isBrandQuestion,
  type ResearchFilter,
} from '@/lib/geo/research-view';
import GeoSelect from './GeoSelect';
import QuestionAssessmentDetails, {
  hasQuestionAssessment,
} from './QuestionAssessmentDetails';
import './question-management.css';

type Props = {
  data: GeoState;
  busy: boolean;
  onAction: (
    action: string,
    fields: Record<string, unknown>,
  ) => Promise<boolean>;
  onResult: (
    question: ResearchQuestion,
    language: 'zh' | 'en',
    engine?: ResearchFilter['engine'],
    record?: { batch: ResearchBatch; recordKey: string },
  ) => void;
  onEvidence: (path: string) => void;
  onLegacy: () => void;
  onRefresh?: () => Promise<void> | void;
};
type Draft = {
  candidateId?: string;
  sourceQuestionId?: string;
  query: string;
  queryEn: string;
  category: QuestionCategory;
  intent: string;
  rationale: string;
  expectedResult: string;
  assetIds: string[];
};
type QuestionRow = {
  key: string;
  research?: ResearchQuestion;
  candidate?: QuestionCandidate;
};
type PendingResearchAudit = {
  projectId: string;
  session: number;
  planId: string;
  revision: number;
  batchId: string;
  questionId: string;
  query: string;
  queryEn: string;
};

const normalizedQuestion = (value: string) =>
  value.normalize('NFC').trim().replace(/\s+/g, ' ');

function matchesResearchWording(
  candidate: QuestionCandidate,
  research: Pick<ResearchQuestion, 'zh' | 'en'>,
) {
  if (
    !research.zh &&
    !candidate.queryEn &&
    normalizedQuestion(candidate.query) === normalizedQuestion(research.en)
  ) {
    return true;
  }
  return (
    normalizedQuestion(candidate.query) === normalizedQuestion(research.zh) &&
    normalizedQuestion(candidate.queryEn || '') ===
      normalizedQuestion(research.en)
  );
}

function matchesResearch(
  candidate: QuestionCandidate,
  research: ResearchQuestion,
) {
  if (candidate.id === research.candidateId || candidate.id === research.id)
    return true;
  const query = normalizedQuestion(candidate.query);
  // Merge only the same wording; a shared source ID alone does not make a
  // rewritten question equivalent. Keep the research record available intact.
  return (
    [research.zh, research.en].some(
      (value) => normalizedQuestion(value) === query,
    ) &&
    (!candidate.queryEn ||
      normalizedQuestion(candidate.queryEn) === normalizedQuestion(research.en))
  );
}
const blank = (): Draft => ({
  query: '',
  queryEn: '',
  category: 'problem',
  intent: '',
  rationale: '',
  expectedResult: '',
  assetIds: [],
});
const decisions: Record<QuestionDecision, string> = {
  include: '现在值得搜',
  explore: '值得保留，待补充',
  exclude: '暂不考虑',
};

export default function QuestionManagementPanel({
  data,
  busy,
  onAction,
  onResult,
  onEvidence,
  onLegacy,
  onRefresh,
}: Props) {
  const [scope, setScope] = useState<'observed' | 'backlog'>('observed');
  const [search, setSearch] = useState('');
  const [language, setLanguage] = useState<'zh' | 'en'>(() =>
    resolveProjectTargetLanguage(data.project, data.latestResearch),
  );
  const [resultEngine, setResultEngine] =
    useState<ResearchFilter['engine']>('all');
  const [kind, setKind] = useState<ResearchFilter['kind']>('all');
  const [resultStatus, setResultStatus] =
    useState<ResearchFilter['result']>('all');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [auditingId, setAuditingId] = useState<string | null>(null);
  const [pendingResearchAudit, setPendingResearchAudit] =
    useState<PendingResearchAudit | null>(null);
  const pendingResearchAuditRef = useRef<PendingResearchAudit | null>(null);
  const [decision, setDecision] = useState<QuestionDecision>('explore');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [loadedResearchBatch, setResearchBatch] =
    useState<ResearchBatch | null>(data.latestResearch ?? null);
  const projectRef = useRef(data.project.id);
  const projectSession = useRef(0);
  if (projectRef.current !== data.project.id) {
    projectRef.current = data.project.id;
    projectSession.current += 1;
  }
  const researchBatch =
    loadedResearchBatch?.projectId === data.project.id
      ? loadedResearchBatch
      : null;
  const modal = useRef<HTMLDialogElement>(null);
  const plan = data.questionPlan;
  const candidates = plan.candidates.filter(
    (item) => !item.supersededByCandidateId,
  );
  const review = candidates.find((item) => item.id === reviewId) ?? null;
  const savedReviewDecision = review?.review.decision;
  const savedReviewReason = review?.review.reason;
  const savedReviewStatus = review?.review.status;
  const selected = candidates.filter((item) => item.selected);
  const pending = candidates.filter((item) => item.review.status === 'pending');
  const observed = researchBatch?.questions ?? [];
  const deferred = researchBatch?.deferredQuestions ?? [];
  const linkedCandidates = new Set<string>();
  for (const research of observed) {
    const candidate = candidates.find((item) =>
      matchesResearch(item, research),
    );
    if (candidate) linkedCandidates.add(candidate.id);
  }
  const backlogRows: QuestionRow[] = deferred.map((research) => {
    const candidate = candidates.find(
      (item) =>
        !linkedCandidates.has(item.id) && matchesResearch(item, research),
    );
    if (candidate) linkedCandidates.add(candidate.id);
    return { key: `research-${research.id}`, research, candidate };
  });
  backlogRows.push(
    ...candidates
      .filter((item) => !linkedCandidates.has(item.id))
      .map((candidate) => ({ key: `candidate-${candidate.id}`, candidate })),
  );
  const rows: QuestionRow[] =
    scope === 'observed'
      ? observed.map((research) => ({
          key: `research-${research.id}`,
          research,
          candidate: candidates.find((item) =>
            matchesResearchWording(item, research),
          ),
        }))
      : backlogRows;
  const recordedEngines = researchBatch
    ? getBatchResearchEngines(researchBatch)
    : [];
  const defaultTargetLang = resolveProjectTargetLanguage(
    data.project,
    researchBatch,
  );
  const hasZhObservations = Boolean(
    researchBatch?.questions.some((q) =>
      q.observations.some((obs) => obs.language === 'zh'),
    ),
  );
  const availableEngines: ResearchEngine[] =
    recordedEngines.length > 0
      ? RESEARCH_ENGINES.filter((engine) => recordedEngines.includes(engine))
      : [...RESEARCH_ENGINES];
  const displayedEngines: ResearchEngine[] =
    resultEngine === 'all' ? availableEngines : [resultEngine];
  const matchingResults = researchBatch
    ? getResearchRows(researchBatch, {
        language,
        engine: resultEngine,
        kind,
        result: resultStatus,
      })
    : [];
  const matchingQuestionIds = new Set(
    matchingResults.map((row) => row.question.id),
  );
  const visibleRows = rows.filter(({ research, candidate }) => {
    if (scope === 'observed' && !matchingQuestionIds.has(research!.id))
      return false;
    const queries = [
      research?.zh,
      research?.en,
      candidate?.query,
      candidate?.queryEn,
    ];
    return queries.join(' ').toLowerCase().includes(search.toLowerCase());
  });

  useEffect(() => {
    setResearchBatch(data.latestResearch ?? null);
  }, [data.latestResearch]);

  useEffect(() => {
    const controller = new AbortController();
    setDraft(null);
    setReviewId(null);
    setAuditingId(null);
    setPendingResearchAudit(null);
    pendingResearchAuditRef.current = null;
    fetch(`/api/geo/research?project=${encodeURIComponent(data.project.id)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) return null;
        return result as {
          batch: ResearchBatch | null;
        };
      })
      .then((result) => {
        if (controller.signal.aborted || !result) return;
        setResearchBatch(result.batch);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [data.project.id]);

  useEffect(() => {
    if (draft || review) {
      if (!modal.current?.open) modal.current?.showModal();
    } else modal.current?.close();
  }, [draft, review]);
  useEffect(() => {
    if (!savedReviewDecision) return;
    setDecision(savedReviewDecision);
    setReason(savedReviewStatus === 'pending' ? '' : savedReviewReason || '');
  }, [reviewId, savedReviewDecision, savedReviewReason, savedReviewStatus]);
  const close = () => {
    if (!busy && !auditingId) {
      setDraft(null);
      setReviewId(null);
      setError('');
    }
  };
  useEffect(() => {
    const read = () => {
      const params = new URLSearchParams(window.location.search);
      const value = params.get('questionScope') || params.get('scope');
      setScope(
        value === 'backlog' || value === 'draft' || value === 'deferred'
          ? 'backlog'
          : 'observed',
      );
      setSearch(params.get('questionSearch') || params.get('search') || '');
      const paramLang = params.get('language');
      setLanguage(
        paramLang === 'zh' || paramLang === 'en'
          ? paramLang
          : resolveProjectTargetLanguage(data.project, data.latestResearch),
      );
      const engine = params.get('engine');
      setResultEngine(isResearchEngine(engine) ? engine : 'all');
      const kind = params.get('kind');
      setKind(kind === 'brand' || kind === 'discovery' ? kind : 'all');
      const result = params.get('result');
      setResultStatus(
        result === 'found' ||
          result === 'not_observed' ||
          result === 'unmeasured'
          ? result
          : 'all',
      );
    };
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, [data.project, data.latestResearch]);
  const controls = (
    patch: Partial<{
      scope: typeof scope;
      search: string;
      language: 'zh' | 'en';
      resultEngine: ResearchFilter['engine'];
      kind: ResearchFilter['kind'];
      resultStatus: ResearchFilter['result'];
    }>,
  ) => {
    const next = {
      scope,
      search,
      language,
      resultEngine,
      kind,
      resultStatus,
      ...patch,
    };
    setScope(next.scope);
    setSearch(next.search);
    setLanguage(next.language);
    setResultEngine(next.resultEngine);
    setKind(next.kind);
    setResultStatus(next.resultStatus);
    const url = new URL(window.location.href);
    url.searchParams.set('questionScope', next.scope);
    url.searchParams.set('questionSearch', next.search);
    url.searchParams.set('search', next.search);
    url.searchParams.delete('questionCategory');
    url.searchParams.set('language', next.language);
    url.searchParams.set('engine', next.resultEngine);
    url.searchParams.set('kind', next.kind);
    url.searchParams.set('result', next.resultStatus);
    window.history.replaceState(null, '', url);
    setError('');
  };
  const action = useCallback(
    async (name: string, fields: Record<string, unknown>) => {
      setError('');
      try {
        const ok = await onAction(name, {
          ...fields,
          planId: plan.id,
          revision: plan.revision,
        });
        if (!ok) setError('操作未保存，请重试。');
        return ok;
      } catch (failure) {
        setError(
          failure instanceof Error ? failure.message : '操作未保存，请重试。',
        );
        return false;
      }
    },
    [onAction, plan.id, plan.revision],
  );
  const reviewCandidate = useCallback((item: QuestionCandidate) => {
    setReviewId(item.id);
    setDecision(item.review.decision);
    setReason(item.review.status === 'pending' ? '' : item.review.reason);
    setError('');
  }, []);
  const auditCandidate = async (item: QuestionCandidate) => {
    if (busy || auditingId || !data.settings.modelConfigured) return;
    const projectId = projectRef.current;
    const session = projectSession.current;
    reviewCandidate(item);
    setAuditingId(item.id);
    try {
      await action('audit_question', { candidateId: item.id });
    } finally {
      if (
        projectRef.current === projectId &&
        projectSession.current === session
      )
        setAuditingId(null);
    }
  };
  const auditResearch = async (item: ResearchQuestion) => {
    if (busy || auditingId || !data.settings.modelConfigured || !researchBatch)
      return;
    const existing = candidates.find((candidate) =>
      matchesResearchWording(candidate, item),
    );
    if (existing) {
      await auditCandidate(existing);
      return;
    }
    const request: PendingResearchAudit = {
      projectId: data.project.id,
      session: projectSession.current,
      planId: plan.id,
      revision: plan.revision,
      batchId: researchBatch.id,
      questionId: item.id,
      query: item.zh || item.en,
      queryEn: item.zh ? item.en : '',
    };
    setAuditingId(`research:${item.id}`);
    const ok = await action('save_question', {
      sourceQuestionId: item.id,
      query: item.zh || item.en,
      queryEn: item.zh ? item.en : '',
      category: isBrandQuestion(item) ? 'brand' : 'problem',
      intent:
        item.valueReason.slice(0, 600).trim() || '原问题的使用情境待核查。',
      rationale:
        item.evidenceBasis.slice(0, 800).trim() || '原问题的争取价值待审阅。',
      expectedResult:
        item.answerability.slice(0, 600).trim() || '当前承接情况待核查。',
      assetIds: [],
    });
    if (
      projectRef.current !== request.projectId ||
      projectSession.current !== request.session
    )
      return;
    if (!ok) {
      setAuditingId(null);
      return;
    }
    pendingResearchAuditRef.current = request;
    setPendingResearchAudit(request);
  };

  useEffect(() => {
    const request = pendingResearchAudit;
    if (!request || pendingResearchAuditRef.current !== request) return;
    if (
      projectRef.current !== request.projectId ||
      projectSession.current !== request.session ||
      plan.id !== request.planId
    ) {
      pendingResearchAuditRef.current = null;
      setPendingResearchAudit(null);
      setAuditingId(null);
      return;
    }
    if (plan.revision <= request.revision) return;
    const candidate = plan.candidates.find(
      (item) =>
        !item.supersededByCandidateId &&
        item.sourceQuestionId === request.questionId &&
        item.sourceResearchBatchId === request.batchId &&
        matchesResearchWording(item, {
          zh: request.query,
          en: request.queryEn,
        }),
    );
    // Consume before dispatch so a rerender cannot audit the same saved draft twice.
    pendingResearchAuditRef.current = null;
    setPendingResearchAudit(null);
    if (!candidate) {
      setAuditingId(null);
      setError('未能在刷新后的题单中找到同文候选，未启动 AI 复评。');
      return;
    }
    reviewCandidate(candidate);
    setAuditingId(candidate.id);
    void action('audit_question', { candidateId: candidate.id }).finally(() => {
      if (
        projectRef.current === request.projectId &&
        projectSession.current === request.session
      )
        setAuditingId(null);
    });
  }, [pendingResearchAudit, plan, action, reviewCandidate]);
  const editCandidate = (item: QuestionCandidate) => {
    setError('');
    setDraft({
      candidateId: item.id,
      query: item.query,
      queryEn: item.queryEn || '',
      category: item.category,
      intent: item.intent,
      rationale: item.rationale,
      expectedResult: item.expectedResult,
      assetIds: item.assetIds,
    });
  };
  const editResearch = (item: ResearchQuestion) => {
    const existing = candidates.find(
      (candidate) =>
        (candidate.sourceQuestionId === item.id &&
          candidate.sourceResearchBatchId === researchBatch?.id) ||
        matchesResearch(candidate, item),
    );
    if (existing) {
      editCandidate(existing);
      return;
    }
    setError('');
    setDraft({
      sourceQuestionId: item.id,
      query: item.zh || item.en,
      queryEn: item.zh ? item.en : '',
      category: isBrandQuestion(item) ? 'brand' : 'problem',
      intent: item.valueReason.slice(0, 600),
      rationale: item.evidenceBasis.slice(0, 800),
      expectedResult: item.answerability.slice(0, 600),
      assetIds: [],
    });
  };
  const saveDraft = async () => {
    if (!draft) return;
    const ok = await action('save_question', {
      ...draft,
      intent: draft.intent.trim() || '用户提出的候选问题，具体使用情境待审阅。',
      rationale:
        draft.rationale.trim() || '用户提出的候选方向，争取价值待审阅。',
      expectedResult:
        draft.expectedResult.trim() ||
        '寻找与原问题相关的帮助，当前承接情况待核查。',
    });
    if (ok) {
      setDraft(null);
      controls({ scope: 'backlog', search: '' });
    }
  };

  return (
    <section className="qm-page" aria-label="问题与结果">
      <nav className="qm-tabs" aria-label="问题分组">
        {(
          [
            ['observed', '核心问题', observed.length],
            ['backlog', '候补问题', backlogRows.length],
          ] as const
        ).map(([key, label, count]) => (
          <button
            key={key}
            aria-pressed={scope === key}
            onClick={() => {
              controls({ scope: key, search: '' });
            }}
          >
            <span>{label}</span>
            <small>{count}</small>
          </button>
        ))}
      </nav>
      <div className="qm-content">
        <div className="qm-toolbar">
          <label className="qm-search">
            <Search size={16} />
            <input
              aria-label="搜索问题"
              placeholder="搜索问题…"
              value={search}
              onChange={(event) => controls({ search: event.target.value })}
            />
          </label>
          {(defaultTargetLang === 'zh' ||
            hasZhObservations ||
            language === 'zh') && (
            <div className="qm-languages" role="group" aria-label="问题语言">
              <button
                aria-pressed={language === 'zh'}
                onClick={() => controls({ language: 'zh' })}
              >
                中文
              </button>
              <button
                aria-pressed={language === 'en'}
                onClick={() => controls({ language: 'en' })}
              >
                English
              </button>
            </div>
          )}
          {scope === 'backlog' && (
            <button className="qm-secondary" onClick={onLegacy}>
              生成用户提问
            </button>
          )}
          <button
            className="qm-primary"
            onClick={() => {
              setError('');
              setDraft(blank());
            }}
          >
            <Plus size={15} />
            添加问题
          </button>
        </div>
        {error && !draft && !review && (
          <p className="qm-error" role="alert">
            {error}
          </p>
        )}
        {scope === 'backlog' && candidates.length > 0 && (
          <div className="qm-batch-bar">
            <span>
              {pending.length} 个待审阅 · 已选 {selected.length} / 8
              {selected.length > 8 && ' · 请调整至最多 8 题'}
              {plan.status === 'ready' && ' · 已确认本批'}
            </span>
            <button
              disabled={
                busy ||
                !selected.length ||
                selected.length > 8 ||
                plan.status === 'ready' ||
                selected.some(
                  (item) =>
                    item.review.status === 'pending' ||
                    item.review.decision === 'exclude',
                )
              }
              onClick={() => void action('confirm_questions', {})}
            >
              {plan.status === 'ready' ? <Check size={14} /> : null}
              {plan.status === 'ready' ? '已确认' : '确认本批'}
            </button>
          </div>
        )}
        <div className="qm-table-wrap">
          <table className="qm-table">
            <thead>
              <tr>
                {scope === 'backlog' && candidates.length > 0 && (
                  <th aria-label="选择本批问题" />
                )}
                <th>
                  <div className="qm-column-heading">
                    <span>问题</span>
                    {scope === 'observed' && (
                      <GeoSelect<ResearchFilter['kind']>
                        label="问题类型"
                        value={kind}
                        onChange={(kind) => controls({ kind })}
                        options={[
                          { value: 'all', label: '全部问题' },
                          { value: 'brand', label: '品牌基础' },
                          { value: 'discovery', label: '需求发现' },
                        ]}
                      />
                    )}
                  </div>
                </th>
                {scope === 'observed' ? (
                  <th className="qm-platform-column">
                    <div className="qm-column-heading qm-platform-heading">
                      <GeoSelect<ResearchFilter['engine']>
                        label="查看结果的平台"
                        value={resultEngine}
                        onChange={(resultEngine) => controls({ resultEngine })}
                        options={[
                          { value: 'all', label: '全部平台' },
                          ...availableEngines.map((engine) => ({
                            value: engine,
                            label: RESEARCH_ENGINE_NAMES[engine],
                          })),
                        ]}
                      />
                      <GeoSelect<ResearchFilter['result']>
                        label="结果状态"
                        value={resultStatus}
                        onChange={(resultStatus) => controls({ resultStatus })}
                        options={[
                          { value: 'all', label: '全部状态' },
                          { value: 'found', label: '已找到' },
                          { value: 'not_observed', label: '本次未见' },
                          { value: 'unmeasured', label: '未搜索' },
                        ]}
                      />
                      <span className="qm-platform-count-heading">
                        找到 / 已搜
                      </span>
                    </div>
                  </th>
                ) : (
                  <th>状态</th>
                )}
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map(({ key, research, candidate }) => (
                <tr key={key}>
                  {scope === 'backlog' && candidates.length > 0 && (
                    <td className="qm-select-cell">
                      {candidate && (
                        <input
                          type="checkbox"
                          aria-label={`纳入本批：${candidate.query}`}
                          checked={candidate.selected}
                          disabled={
                            busy ||
                            candidate.review.status === 'pending' ||
                            candidate.review.decision === 'exclude' ||
                            (!candidate.selected && selected.length >= 8)
                          }
                          onChange={(event) =>
                            void action('select_question', {
                              candidateId: candidate.id,
                              selected: event.target.checked,
                            })
                          }
                        />
                      )}
                    </td>
                  )}
                  <td>
                    <button
                      className="qm-question"
                      onClick={() =>
                        scope === 'observed' && research
                          ? onResult(research, language, resultEngine)
                          : candidate
                            ? reviewCandidate(candidate)
                            : onResult(research!, language, resultEngine)
                      }
                    >
                      {scope === 'observed' && research
                        ? research[language] ||
                          research[language === 'zh' ? 'en' : 'zh']
                        : candidate
                          ? language === 'en'
                            ? candidate.queryEn || candidate.query
                            : candidate.query
                          : research![language] ||
                            research![language === 'zh' ? 'en' : 'zh']}
                    </button>
                    {research && !research[language]?.trim() && (
                      <small className="qm-note">
                        尚缺{language === 'zh' ? '中文' : '英文'}问法
                      </small>
                    )}
                    {scope === 'observed' && research?.valueReason && (
                      <p className="qm-question-value">
                        {research.valueReason}
                      </p>
                    )}
                    {candidate && !hasQuestionAssessment(candidate) && (
                      <small className="qm-note">未进行 AI 双判断</small>
                    )}
                  </td>
                  {scope === 'observed' && research ? (
                    <td className="qm-platform-column">
                      {(() => {
                        const results = displayedEngines.map((engine) => ({
                          engine,
                          latest: getLatestResearchObservation(
                            research.observations.filter(
                              (item) =>
                                item.language === language &&
                                item.engine === engine,
                            ),
                          ),
                        }));
                        const searched = results.filter(
                          ({ latest }) => latest,
                        ).length;
                        const found = results.filter(
                          ({ latest }) => latest?.status === 'found',
                        ).length;
                        return (
                          <div className="qm-platform-results">
                            <div className="qm-platform-icons">
                              {results.map(({ engine, latest }) => {
                                const status = !latest
                                  ? 'unmeasured'
                                  : latest.status === 'found'
                                    ? 'found'
                                    : 'absent';
                                const statusText = !latest
                                  ? '未搜索'
                                  : latest.status === 'found'
                                    ? '已找到'
                                    : '本次未见';
                                return (
                                  <button
                                    key={engine}
                                    className={`qm-platform-result ${status}`}
                                    aria-label={`${research[language]} · ${RESEARCH_ENGINE_NAMES[engine]} · ${statusText}`}
                                    onClick={() =>
                                      onResult(research, language, engine)
                                    }
                                  >
                                    <ResearchEngineIcon engine={engine} />
                                    <span
                                      className="qm-platform-status"
                                      aria-hidden="true"
                                    >
                                      {status === 'found' ? (
                                        <Check size={10} strokeWidth={3} />
                                      ) : status === 'absent' ? (
                                        <X size={10} strokeWidth={2.5} />
                                      ) : (
                                        <Minus size={10} strokeWidth={2.5} />
                                      )}
                                    </span>
                                    <span
                                      className="qm-platform-tooltip"
                                      role="tooltip"
                                    >
                                      <strong>
                                        {RESEARCH_ENGINE_NAMES[engine]}
                                      </strong>
                                      <span>
                                        {statusText}
                                        {latest
                                          ? ` · ${(latest.collectedAt || latest.recordedAt).slice(0, 10)}`
                                          : ''}
                                      </span>
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                            <button
                              className={`qm-platform-total ${found ? 'has-found' : ''}`}
                              aria-label={`${found} 个平台找到，${searched} 个平台已搜索，${results.length - searched} 个平台未搜索；查看结果`}
                              title={`找到 ${found} · 已搜 ${searched} · 未搜 ${results.length - searched}`}
                              onClick={() =>
                                onResult(research, language, resultEngine)
                              }
                            >
                              <strong>{searched ? found : '—'}</strong>
                              <span>/ {searched}</span>
                            </button>
                          </div>
                        );
                      })()}
                    </td>
                  ) : (
                    <td>
                      <span
                        className={
                          candidate?.review.status === 'pending'
                            ? 'qm-pending'
                            : ''
                        }
                      >
                        {candidate
                          ? candidate.review.status === 'pending'
                            ? '待人工审阅'
                            : decisions[candidate.review.decision]
                          : '待补充'}
                      </span>
                    </td>
                  )}
                  <td>
                    <div className="qm-actions">
                      {scope === 'observed' && research && (
                        <button
                          onClick={() =>
                            onResult(research, language, resultEngine)
                          }
                        >
                          查看结果
                        </button>
                      )}
                      {candidate ? (
                        <>
                          <button
                            disabled={busy || !!auditingId}
                            onClick={() => editCandidate(candidate)}
                          >
                            {scope === 'observed' ? '调整下一批' : '编辑'}
                          </button>
                          <button
                            disabled={
                              busy ||
                              !!auditingId ||
                              !data.settings.modelConfigured
                            }
                            title={
                              data.settings.modelConfigured
                                ? undefined
                                : '请先配置分析模型'
                            }
                            onClick={() =>
                              void (research
                                ? auditResearch(research)
                                : auditCandidate(candidate))
                            }
                          >
                            {auditingId === candidate.id ||
                            auditingId === `research:${research?.id}`
                              ? 'AI 复评中…'
                              : 'AI 复评'}
                          </button>
                          <button
                            disabled={busy || !!auditingId}
                            onClick={() => reviewCandidate(candidate)}
                          >
                            {hasQuestionAssessment(candidate)
                              ? '审核结果'
                              : '审阅'}
                          </button>
                          {research && scope !== 'observed' && (
                            <button
                              onClick={() => onResult(research, language)}
                            >
                              原始依据
                            </button>
                          )}
                        </>
                      ) : (
                        <>
                          {research && (
                            <button
                              disabled={
                                busy ||
                                !!auditingId ||
                                !data.settings.modelConfigured
                              }
                              title={
                                data.settings.modelConfigured
                                  ? undefined
                                  : '请先配置分析模型'
                              }
                              onClick={() => void auditResearch(research)}
                            >
                              {auditingId === `research:${research.id}`
                                ? 'AI 复评中…'
                                : 'AI 复评'}
                            </button>
                          )}
                          {scope !== 'observed' && (
                            <button
                              onClick={() =>
                                onResult(research!, language, resultEngine)
                              }
                            >
                              查看详情
                            </button>
                          )}
                          <button
                            disabled={busy || !!auditingId}
                            onClick={() => editResearch(research!)}
                          >
                            调整下一批
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!visibleRows.length && (
            <p className="qm-empty">
              没有符合当前筛选的问题。
              <button
                onClick={() =>
                  controls({
                    search: '',
                    resultEngine: 'all',
                    kind: 'all',
                    resultStatus: 'all',
                  })
                }
              >
                清除筛选
              </button>
            </p>
          )}
        </div>
        {researchBatch && (
          <details className="qm-research-basis">
            <summary>调查依据与观测范围</summary>
            <p>{researchBatch.productSummary}</p>
            <p>{researchBatch.contributionSummary}</p>
            <p>{researchBatch.scopeNote}</p>
            <p>
              各平台分别展示当前语言的最新记录，历史回答保留在问题详情。“已找到”表示该次记录发现官方来源；“本次未见”不代表未收录，未测也不等于未找到。Google
              是普通网页结果，API 入口不代表消费端回答。
            </p>
            <p>下一步：{researchBatch.nextStep}</p>
            <button onClick={() => onEvidence(researchBatch.sourceAuditPath)}>
              产品调查依据
            </button>
            <button onClick={() => onEvidence(researchBatch.reviewPath)}>
              题单审核依据
            </button>
          </details>
        )}
      </div>
      <dialog
        ref={modal}
        className="qm-dialog"
        aria-label={draft ? '编辑问题' : '问题审阅'}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
      >
        <header>
          <h2>
            {draft
              ? draft.candidateId || draft.sourceQuestionId
                ? '调整下一批问题'
                : '添加问题'
              : '问题审阅'}
          </h2>
          <button
            type="button"
            disabled={busy || !!auditingId}
            onClick={close}
            aria-label="关闭问题编辑"
          >
            <X size={18} />
          </button>
        </header>
        {draft ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void saveDraft();
            }}
          >
            <label>
              中文问法
              <textarea
                autoFocus
                required
                minLength={3}
                maxLength={300}
                rows={3}
                value={draft.query}
                onChange={(event) =>
                  setDraft({ ...draft, query: event.target.value })
                }
              />
            </label>
            <label>
              英文问法 <span className="qm-note">选填</span>
              <textarea
                maxLength={300}
                rows={2}
                value={draft.queryEn}
                onChange={(event) =>
                  setDraft({ ...draft, queryEn: event.target.value })
                }
                placeholder="同一需求的自然英文问法"
              />
            </label>
            <details>
              <summary>使用情境与已有依据</summary>
              <label>
                谁会在什么情况下问？
                <textarea
                  maxLength={600}
                  value={draft.intent}
                  onChange={(event) =>
                    setDraft({ ...draft, intent: event.target.value })
                  }
                />
              </label>
              <label>
                为什么值得争取？
                <textarea
                  maxLength={800}
                  value={draft.rationale}
                  onChange={(event) =>
                    setDraft({ ...draft, rationale: event.target.value })
                  }
                />
              </label>
              <label>
                希望找到什么帮助？
                <textarea
                  maxLength={600}
                  value={draft.expectedResult}
                  onChange={(event) =>
                    setDraft({ ...draft, expectedResult: event.target.value })
                  }
                />
              </label>
              <fieldset>
                <legend>关联已有内容</legend>
                {data.assets.map((asset) => (
                  <label className="qm-check" key={asset.id}>
                    <input
                      type="checkbox"
                      checked={draft.assetIds.includes(asset.id)}
                      disabled={
                        !draft.assetIds.includes(asset.id) &&
                        draft.assetIds.length >= 8
                      }
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          assetIds: event.target.checked
                            ? [...draft.assetIds, asset.id]
                            : draft.assetIds.filter((id) => id !== asset.id),
                        })
                      }
                    />
                    {asset.title}
                  </label>
                ))}
              </fieldset>
            </details>
            <p className="qm-note">
              保存后进入待审阅；已搜索的问题和结果保留原样。
            </p>
            {error && <p role="alert">{error}</p>}
            <footer>
              <button type="button" onClick={close} disabled={busy}>
                取消
              </button>
              <button className="qm-primary" disabled={busy}>
                {busy ? '正在保存…' : '保存为待审阅'}
              </button>
            </footer>
          </form>
        ) : (
          review && (
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                const ok = await action('review_question', {
                  candidateId: review.id,
                  decision,
                  reason,
                });
                if (ok) setReviewId(null);
              }}
            >
              <h3>{review.query}</h3>
              <p className="qm-note" lang={review.queryEn ? 'en' : 'zh'}>
                {review.queryEn || '尚未设置中英配对'}
              </p>
              <button
                type="button"
                className="qm-secondary"
                disabled={
                  busy || !!auditingId || !data.settings.modelConfigured
                }
                title={
                  data.settings.modelConfigured ? undefined : '请先配置分析模型'
                }
                onClick={() => void auditCandidate(review)}
              >
                {auditingId === review.id ? 'AI 复评中…' : 'AI 复评'}
              </button>
              <QuestionAssessmentDetails
                candidate={review}
                assets={data.assets}
              />
              <dl>
                <dt>使用情境</dt>
                <dd>{review.intent}</dd>
                <dt>争取价值</dt>
                <dd>{review.rationale}</dd>
                <dt>期待帮助</dt>
                <dd>{review.expectedResult}</dd>
              </dl>
              <details>
                <summary>已有内容与待核查项</summary>
                {review.evidence.map((item) => (
                  <blockquote key={item.assetId}>
                    <strong>
                      {data.assets.find((asset) => asset.id === item.assetId)
                        ?.title || '关联材料'}
                    </strong>
                    <p>{item.quote}</p>
                  </blockquote>
                ))}
                {!review.evidence.length && (
                  <p>尚未关联材料证据；可保留为探索问题。</p>
                )}
                {review.review.concerns.map((item, index) => (
                  <p key={index}>{item}</p>
                ))}
              </details>
              <label>
                我的判断
                <GeoSelect<QuestionDecision>
                  label="我的判断"
                  value={decision}
                  onChange={setDecision}
                  options={Object.entries(decisions).map(([key, label]) => ({
                    value: key as QuestionDecision,
                    label,
                  }))}
                  portalTarget={modal}
                />
              </label>
              <label>
                判断依据
                <textarea
                  required
                  minLength={5}
                  maxLength={900}
                  rows={3}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="说明为什么值得搜，或为什么先保留、暂不考虑。"
                />
              </label>
              {error && <p role="alert">{error}</p>}
              <footer>
                <button type="button" onClick={close} disabled={busy}>
                  取消
                </button>
                <button className="qm-primary" disabled={busy}>
                  {busy ? '正在保存…' : '保存人工审阅'}
                </button>
              </footer>
            </form>
          )
        )}
      </dialog>
    </section>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Download,
  FileText,
  Loader2,
  Sparkles,
} from 'lucide-react';
import type { GeoAsset } from '@/lib/geo/types';
import {
  QUESTION_CATEGORY_LABELS,
  type GeoQuestionPlan,
  type QuestionCandidate,
  type QuestionCategory,
  type QuestionGenerationProgress,
  type QuestionGenerationJob,
} from '@/lib/geo/question-types';
import GeoSelect from './GeoSelect';
import BackgroundPreparationStatus, {
  QuestionGenerationRequestStatus,
  useQuestionGenerationStep,
} from './BackgroundPreparationStatus';
import QuestionAssessmentDetails, {
  hasQuestionAssessment,
} from './QuestionAssessmentDetails';
import './question-plan.css';

type Props = {
  plan: GeoQuestionPlan;
  assets: GeoAsset[];
  modelConfigured: boolean;
  busy: boolean;
  generationProgress?: QuestionGenerationProgress;
  generationJob?: QuestionGenerationJob | null;
  onGenerate: (positioning: string) => Promise<void>;
  onToggle: (candidateId: string, selected: boolean) => Promise<void>;
  onConfirm: () => Promise<void>;
  onAsset: (asset: GeoAsset) => void;
  onContinue?: () => void;
  onConfigureModel?: () => void;
  onAuditCandidate?: (candidateId: string) => Promise<void>;
};

const decisionLabels = {
  include: '推荐',
  explore: '可进一步了解',
  exclude: '暂不推荐',
};

const generationSteps = ['选题方向', '生成问题', '独立审核', '保存'];

export default function QuestionPlanPanel({
  plan,
  assets,
  modelConfigured,
  busy,
  generationProgress,
  generationJob,
  onGenerate,
  onToggle,
  onConfirm,
  onAsset,
  onContinue,
  onConfigureModel,
  onAuditCandidate,
}: Props) {
  const preparedPositioning = generationJob?.positioning || plan.positioning;
  const [positioning, setPositioning] = useState(preparedPositioning);
  const [editingPositioning, setEditingPositioning] = useState(
    !preparedPositioning.trim(),
  );
  const [generating, setGenerating] = useState(false);
  const generatingRef = useRef(false);
  const [generationError, setGenerationError] = useState('');
  const [category, setCategory] = useState<QuestionCategory | 'all'>('all');
  const [showAll, setShowAll] = useState(false);
  const [showExplore, setShowExplore] = useState(false);
  const [showExcluded, setShowExcluded] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [auditingId, setAuditingId] = useState<string | null>(null);
  const [auditError, setAuditError] = useState('');
  const hasCandidates = plan.candidates.length > 0;
  const generationJobActive =
    generationJob?.status === 'queued' || generationJob?.status === 'running';
  const generationPending =
    generating || (busy && !!generationProgress) || generationJobActive;
  const working = busy || generationPending;
  const generationStep = useQuestionGenerationStep(
    generationProgress,
    generationPending ? 'active-generation' : undefined,
  );
  const questionContent = plan.candidates
    .map((candidate) => `${candidate.id}:${candidate.query}`)
    .join('\n');

  useEffect(() => {
    setPositioning(preparedPositioning);
    setEditingPositioning(!preparedPositioning.trim());
    setGenerationError('');
  }, [plan.id, preparedPositioning]);

  useEffect(() => {
    setExpanded({});
    setShowAll(false);
    setCategory('all');
  }, [plan.id, questionContent]);

  const positioningChanged = positioning.trim() !== preparedPositioning.trim();
  const selected = plan.candidates.filter(
    (candidate) =>
      candidate.selected && candidate.review.decision !== 'exclude',
  );
  const matching = plan.candidates.filter(
    (candidate) => category === 'all' || candidate.category === category,
  );
  const recommended = matching
    .filter(
      (candidate) =>
        candidate.review.decision !== 'exclude' &&
        (candidate.selected || candidate.review.decision === 'include'),
    )
    .sort((a, b) => Number(b.selected) - Number(a.selected));
  const exploratory = matching.filter(
    (candidate) =>
      candidate.review.decision === 'explore' && !candidate.selected,
  );
  const excluded = matching.filter(
    (candidate) => candidate.review.decision === 'exclude',
  );
  const representatives = (
    Object.keys(QUESTION_CATEGORY_LABELS) as QuestionCategory[]
  ).flatMap((key) => {
    const candidate = recommended.find((item) => item.category === key);
    return candidate ? [candidate] : [];
  });
  const orderedRecommended = [
    ...representatives,
    ...recommended.filter((item) => !representatives.includes(item)),
  ];
  const collapsedRecommended = orderedRecommended.filter(
    (candidate, index) => candidate.selected || index < 5,
  );
  const visibleRecommended = showAll
    ? orderedRecommended
    : collapsedRecommended;
  const moreRecommendedCount =
    orderedRecommended.length - collapsedRecommended.length;
  const assetFor = (id: string) => assets.find((asset) => asset.id === id);

  async function generateQuestions() {
    if (
      generatingRef.current ||
      working ||
      !modelConfigured ||
      !positioning.trim()
    )
      return;
    generatingRef.current = true;
    setGenerationError('');
    setGenerating(true);
    try {
      await onGenerate(positioning.trim());
      setEditingPositioning(false);
    } catch (failure) {
      setGenerationError(
        failure instanceof Error ? failure.message : '生成未完成，请重试。',
      );
    } finally {
      generatingRef.current = false;
      setGenerating(false);
    }
  }

  function downloadPlan() {
    const exportData = {
      ...plan,
      candidates: selected,
      exportScope: 'selected_questions',
      measurementStatus: 'not_measured',
      exportedAt: new Date().toISOString(),
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(exportData, null, 2)], {
        type: 'application/json;charset=utf-8',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `opengeo-questions-r${plan.revision}-${plan.status}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderPositioning() {
    return (
      <div className="qp-positioning-body">
        <div className="qp-positioning-heading">
          <h2>产品定位</h2>
          {!editingPositioning && (
            <button
              type="button"
              className="og-text-button"
              disabled={working}
              onClick={() => setEditingPositioning(true)}
            >
              修改
            </button>
          )}
        </div>
        {editingPositioning ? (
          <>
            <label className="qp-sr-only" htmlFor="qp-positioning">
              产品定位
            </label>
            <textarea
              id="qp-positioning"
              value={positioning}
              maxLength={1000}
              rows={4}
              disabled={working}
              placeholder="你的产品为谁提供什么帮助？"
              onChange={(event) => setPositioning(event.target.value)}
            />
            <div className="qp-positioning-edit-actions">
              <button
                type="button"
                className="og-text-button"
                disabled={working || !positioning.trim()}
                onClick={() => setEditingPositioning(false)}
              >
                完成修改
              </button>
              {preparedPositioning.trim() && (
                <button
                  type="button"
                  className="qp-detail-toggle"
                  disabled={working}
                  onClick={() => {
                    setPositioning(preparedPositioning);
                    setEditingPositioning(false);
                  }}
                >
                  取消修改
                </button>
              )}
            </div>
          </>
        ) : (
          <p className="qp-positioning-text">{positioning}</p>
        )}
        {hasCandidates && positioningChanged && (
          <div className="qp-positioning-change" role="status">
            <span>定位已修改，请重新生成问题后再确认。</span>
            <button
              type="button"
              disabled={working}
              onClick={() => setPositioning(preparedPositioning)}
            >
              恢复原定位
            </button>
          </div>
        )}
      </div>
    );
  }

  function renderGeneration() {
    return (
      <div className="qp-generation">
        {generationJob &&
          (!generationPending || generationJobActive) &&
          (hasCandidates && generationJob.status === 'completed' ? (
            <details className="og-background-preparation-history">
              <summary>查看生成过程</summary>
              <BackgroundPreparationStatus job={generationJob} />
            </details>
          ) : (
            <BackgroundPreparationStatus job={generationJob} />
          ))}
        {generationPending && generationJobActive ? null : generationPending ? (
          <div className="qp-generating" role="status" aria-live="polite">
            <ol className="qp-generation-steps" aria-label="生成进度">
              {generationSteps.map((step, index) => (
                <li
                  key={step}
                  className={
                    index < generationStep
                      ? 'is-done'
                      : index === generationStep
                        ? 'is-active'
                        : undefined
                  }
                  aria-current={index === generationStep ? 'step' : undefined}
                >
                  <span className="qp-generation-step-icon" aria-hidden="true">
                    {index < generationStep ? (
                      <Check size={16} />
                    ) : index === generationStep ? (
                      <Loader2 size={16} className="spin" />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <span>{step}</span>
                  <span className="qp-sr-only">
                    {index < generationStep
                      ? '已完成'
                      : index === generationStep
                        ? '进行中'
                        : '等待中'}
                  </span>
                </li>
              ))}
            </ol>
            <p>{generationProgress?.message || '正在准备产品材料…'}</p>
            <QuestionGenerationRequestStatus
              request={generationProgress?.request}
              active={generationPending}
            />
          </div>
        ) : (
          <>
            {!hasCandidates && (
              <p className="qp-generation-purpose">
                了解潜在用户可能向 AI 提出哪些与你产品相关的问题。
              </p>
            )}
            {generationError && (
              <div className="qp-generation-error" role="alert">
                <strong>生成未完成</strong>
                <p>{generationError}</p>
              </div>
            )}
            {modelConfigured ? (
              <button
                type="button"
                className={`og-button ${hasCandidates ? 'secondary' : 'primary'} qp-generate-button`}
                disabled={working || !positioning.trim()}
                onClick={() => void generateQuestions()}
              >
                <Sparkles size={17} />
                {generationError ||
                ['failed', 'interrupted', 'superseded'].includes(
                  generationJob?.status ?? '',
                )
                  ? '重试生成用户提问'
                  : hasCandidates
                    ? '重新生成用户提问'
                    : '生成用户提问'}
              </button>
            ) : (
              <div className="qp-model-setup">
                <p>先在设置中配置分析模型，即可生成用户提问。</p>
                {onConfigureModel && (
                  <button
                    type="button"
                    className="og-button primary"
                    disabled={working}
                    onClick={onConfigureModel}
                  >
                    去设置模型 <ArrowUpRight size={16} />
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  function renderCandidate(candidate: QuestionCandidate) {
    const isExcluded = candidate.review.decision === 'exclude';
    const detailsId = `qp-details-${candidate.id}`;
    const associated = [
      ...new Set([
        ...candidate.assetIds,
        ...candidate.evidence.map((evidence) => evidence.assetId),
      ]),
    ].flatMap((id) => {
      const asset = assetFor(id);
      return asset ? [asset] : [];
    });
    return (
      <article
        className={`qp-question ${candidate.selected && !isExcluded ? 'qp-question-selected' : ''} ${isExcluded ? 'qp-question-excluded' : ''}`}
        key={candidate.id}
      >
        <div className="qp-question-heading">
          <label className="qp-candidate-title">
            <input
              type="checkbox"
              aria-label={`选择问题：${candidate.query}`}
              checked={candidate.selected && !isExcluded}
              disabled={
                working ||
                isExcluded ||
                (!candidate.selected && selected.length >= 8)
              }
              onChange={(event) =>
                void onToggle(candidate.id, event.target.checked)
              }
            />
            <h3>{candidate.query}</h3>
          </label>
          <div className="qp-question-meta">
            <span>{QUESTION_CATEGORY_LABELS[candidate.category]}</span>
            <span
              className={`qp-decision qp-decision-${candidate.review.decision}`}
            >
              {decisionLabels[candidate.review.decision]}
            </span>
            <button
              type="button"
              className="qp-detail-toggle"
              disabled={working}
              aria-expanded={!!expanded[candidate.id]}
              aria-controls={detailsId}
              onClick={() =>
                setExpanded((current) => ({
                  ...current,
                  [candidate.id]: !current[candidate.id],
                }))
              }
            >
              {expanded[candidate.id]
                ? '收起依据'
                : isExcluded
                  ? '为什么暂不推荐'
                  : '为什么选它'}
              <ChevronDown size={14} />
            </button>
          </div>
          {candidate.review.concerns.length > 0 && !isExcluded && (
            <p className="qp-question-caveat">
              待核实：{candidate.review.concerns[0]}
            </p>
          )}
        </div>
        {expanded[candidate.id] && (
          <div className="qp-question-details" id={detailsId}>
            <p className="qp-review">{candidate.review.reason}</p>
            <div className="qp-review-meta">
              <span>
                {candidate.origin === 'existing'
                  ? '已有问题'
                  : candidate.origin === 'model'
                    ? 'AI 生成'
                    : '整理补充'}
              </span>
              <span>
                {hasQuestionAssessment(candidate)
                  ? '已检查需求价值与承接情况'
                  : '需求价值与承接情况尚待核实'}
              </span>
              {onAuditCandidate && (
                <button
                  type="button"
                  className="qp-detail-toggle"
                  disabled={working || !!auditingId || !modelConfigured}
                  title={modelConfigured ? undefined : '请先配置分析模型'}
                  onClick={async () => {
                    setAuditError('');
                    setAuditingId(candidate.id);
                    try {
                      await onAuditCandidate(candidate.id);
                    } catch (failure) {
                      setAuditError(
                        failure instanceof Error
                          ? failure.message
                          : '审核未完成，请重试。',
                      );
                    } finally {
                      setAuditingId(null);
                    }
                  }}
                >
                  {auditingId === candidate.id ? (
                    <>
                      <Loader2 size={14} className="spin" /> 正在审核…
                    </>
                  ) : (
                    '重新审核'
                  )}
                </button>
              )}
            </div>
            <QuestionAssessmentDetails candidate={candidate} assets={assets} />
            <dl>
              <div>
                <dt>用户想了解什么</dt>
                <dd>{candidate.intent}</dd>
              </div>
              <div>
                <dt>与我们的关系</dt>
                <dd>{candidate.rationale}</dd>
              </div>
              <div>
                <dt>希望观察到什么</dt>
                <dd>{candidate.expectedResult}</dd>
              </div>
              <div>
                <dt>搜索目标</dt>
                <dd>{candidate.target === 'article' ? '已有文章' : '项目'}</dd>
              </div>
            </dl>
            {associated.length > 0 && (
              <div className="qp-supporting-assets">
                <span className="qp-detail-label">相关材料</span>
                {associated.map((asset) => (
                  <div className="qp-asset-link" key={asset.id}>
                    <button
                      type="button"
                      disabled={working}
                      onClick={() => onAsset(asset)}
                    >
                      <FileText size={14} />
                      {asset.title}
                    </button>
                    {asset.publicUrl && (
                      <a
                        href={asset.publicUrl}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`打开网页：${asset.title}`}
                      >
                        <ArrowUpRight size={15} />
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
            {candidate.evidence.length > 0 && (
              <div className="qp-quotes">
                <span className="qp-detail-label">材料中的原文</span>
                {candidate.evidence.map((evidence, index) => (
                  <figure key={`${evidence.assetId}-${index}`}>
                    <blockquote>{evidence.quote}</blockquote>
                    <figcaption>
                      {assetFor(evidence.assetId)?.title ?? evidence.assetId}
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}
            {candidate.review.concerns.length > 0 && (
              <div className="qp-concerns">
                <span className="qp-detail-label">待核实</span>
                <ul>
                  {candidate.review.concerns.map((concern, index) => (
                    <li key={index}>{concern}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </article>
    );
  }

  if (
    !hasCandidates ||
    (generationJob && generationJob.status !== 'completed')
  ) {
    return (
      <div className="qp-panel qp-start" aria-busy={working}>
        <section
          className="qp-positioning qp-positioning-primary"
          aria-label="产品定位"
        >
          {renderPositioning()}
        </section>
        {renderGeneration()}
      </div>
    );
  }

  return (
    <div className="qp-panel" aria-busy={working}>
      {generationJob && <BackgroundPreparationStatus job={generationJob} />}
      <section className="qp-questions" aria-label="用户可能这样问">
        <div className="qp-list-heading">
          <div>
            <h2>用户可能这样问</h2>
            <p className="qp-help">
              {selected.length
                ? '推荐问题已勾选，可按需调整，最多 8 个。'
                : '选择与你产品相关的问题，最多 8 个。'}
            </p>
          </div>
          <div className="qp-filter">
            <GeoSelect<QuestionCategory | 'all'>
              label="按问题类别筛选"
              disabled={working}
              value={category}
              onChange={(value) => {
                setCategory(value);
                setShowAll(false);
              }}
              options={[
                { value: 'all', label: '全部类别' },
                ...(
                  Object.entries(QUESTION_CATEGORY_LABELS) as [
                    QuestionCategory,
                    string,
                  ][]
                ).map(([value, label]) => ({ value, label })),
              ]}
            />
          </div>
        </div>
        {auditError && (
          <p className="qp-generation-error" role="alert">
            {auditError}
          </p>
        )}
        <div className="qp-list">
          {visibleRecommended.map(renderCandidate)}
          {!recommended.length && (
            <p className="qp-empty">
              {category === 'all'
                ? '暂时没有推荐的问题，可查看下方其他问题及判断依据。'
                : '此类别暂无推荐的问题，可切换类别或查看下方其他问题。'}
            </p>
          )}
        </div>
        {moreRecommendedCount > 0 && (
          <button
            type="button"
            className="qp-show-more"
            disabled={working}
            aria-expanded={showAll}
            onClick={() => setShowAll(!showAll)}
          >
            {showAll
              ? '收起更多问题'
              : `查看其余 ${moreRecommendedCount} 个推荐问题`}
            <ChevronDown size={14} />
          </button>
        )}
        {exploratory.length > 0 && (
          <section className="qp-secondary-group">
            <button
              type="button"
              className="qp-group-toggle"
              disabled={working}
              aria-expanded={showExplore}
              aria-controls="qp-exploratory"
              onClick={() => setShowExplore(!showExplore)}
            >
              <span>
                其他可选问题 <small>{exploratory.length}</small>
              </span>
              <ChevronDown size={15} />
            </button>
            {showExplore && (
              <div className="qp-list" id="qp-exploratory">
                {exploratory.map(renderCandidate)}
              </div>
            )}
          </section>
        )}
        {excluded.length > 0 && (
          <section className="qp-secondary-group">
            <button
              type="button"
              className="qp-group-toggle"
              disabled={working}
              aria-expanded={showExcluded}
              aria-controls="qp-excluded"
              onClick={() => setShowExcluded(!showExcluded)}
            >
              <span>
                暂不推荐的问题 <small>{excluded.length}</small>
              </span>
              <ChevronDown size={15} />
            </button>
            {showExcluded && (
              <div className="qp-list" id="qp-excluded">
                {excluded.map(renderCandidate)}
              </div>
            )}
          </section>
        )}
      </section>
      {(generationPending || generationError) && (
        <div className="qp-generation-feedback">{renderGeneration()}</div>
      )}
      <details className="qp-positioning qp-positioning-secondary">
        <summary>
          产品定位 <ChevronDown size={15} />
        </summary>
        {renderPositioning()}
        {!generationPending && !generationError && renderGeneration()}
      </details>
      <footer className="qp-footer">
        <p className="qp-save-state" role="status">
          {working ? (
            <Loader2 size={15} className="spin" />
          ) : plan.status === 'ready' ? (
            <Check size={15} />
          ) : null}
          {generationPending
            ? `正在${generationSteps[generationStep]}…`
            : busy
              ? '正在保存…'
              : plan.status === 'ready'
                ? `已确认 ${selected.length} 个问题`
                : selected.length > 8
                  ? `已选 ${selected.length} 个，请减少到 8 个以内`
                  : `已选 ${selected.length} 个问题`}
        </p>
        <div className="qp-footer-actions">
          <button
            type="button"
            className="og-text-button"
            disabled={working || !selected.length || positioningChanged}
            onClick={downloadPlan}
          >
            <Download size={14} />
            导出问题
          </button>
          {plan.status !== 'ready' && (
            <button
              type="button"
              className="og-button primary"
              disabled={
                working ||
                !selected.length ||
                selected.length > 8 ||
                positioningChanged
              }
              onClick={() => void onConfirm()}
            >
              {selected.length
                ? `确认这 ${selected.length} 个问题`
                : '确认选择'}
            </button>
          )}
          {plan.status === 'ready' && onContinue && (
            <button
              type="button"
              className="og-button primary"
              disabled={working || positioningChanged}
              onClick={onContinue}
            >
              选择搜索方式
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

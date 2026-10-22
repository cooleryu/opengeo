'use client';

import { useEffect, useState } from 'react';
import {
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
} from '@/lib/geo/question-types';
import './question-plan.css';

type Props = {
  plan: GeoQuestionPlan;
  assets: GeoAsset[];
  modelConfigured: boolean;
  busy: boolean;
  onGenerate: (positioning: string) => Promise<void>;
  onToggle: (candidateId: string, selected: boolean) => Promise<void>;
  onConfirm: () => Promise<void>;
  onAsset: (asset: GeoAsset) => void;
  onContinue?: () => void;
};

const decisionLabels = {
  include: '建议测',
  explore: '待探索',
  exclude: '暂不测',
};

export default function QuestionPlanPanel({
  plan,
  assets,
  modelConfigured,
  busy,
  onGenerate,
  onToggle,
  onConfirm,
  onAsset,
  onContinue,
}: Props) {
  const [positioning, setPositioning] = useState(plan.positioning);
  const [category, setCategory] = useState<QuestionCategory | 'all'>('all');
  const [showAll, setShowAll] = useState(false);
  const [showExplore, setShowExplore] = useState(false);
  const [showExcluded, setShowExcluded] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const questionContent = plan.candidates
    .map((candidate) => `${candidate.id}:${candidate.query}`)
    .join('\n');

  useEffect(() => {
    setPositioning(plan.positioning);
  }, [plan.id, plan.positioning]);

  useEffect(() => {
    setExpanded({});
    setShowAll(false);
  }, [plan.id, questionContent]);

  const positioningChanged = positioning.trim() !== plan.positioning.trim();
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
  const visibleRecommended = showAll
    ? orderedRecommended
    : orderedRecommended.slice(0, 5);
  const assetFor = (id: string) => assets.find((asset) => asset.id === id);

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

  function renderCandidate(candidate: QuestionCandidate) {
    const isExcluded = candidate.review.decision === 'exclude';
    const detailsId = `qp-details-${candidate.id}`;
    const associated = candidate.assetIds.flatMap((id) => {
      const asset = assetFor(id);
      return asset ? [asset] : [];
    });
    return (
      <article
        className={`qp-question ${candidate.selected && !isExcluded ? 'qp-question-selected' : ''} ${isExcluded ? 'qp-question-excluded' : ''}`}
        key={candidate.id}
      >
        <div className="qp-question-heading">
          <input
            type="checkbox"
            aria-label={`选择问题：${candidate.query}`}
            checked={candidate.selected && !isExcluded}
            disabled={busy || isExcluded}
            onChange={(event) =>
              void onToggle(candidate.id, event.target.checked)
            }
          />
          <div className="qp-question-main">
            <div className="qp-question-meta">
              <span>{QUESTION_CATEGORY_LABELS[candidate.category]}</span>
              <span>
                {candidate.target === 'article' ? '发现文章' : '寻找项目'}
              </span>
              <span>
                {candidate.origin === 'existing'
                  ? '历史题'
                  : candidate.origin === 'model'
                    ? 'AI 新增'
                    : '整理新增'}
              </span>
              <span>本轮未测</span>
            </div>
            <h3>{candidate.query}</h3>
            <p className="qp-review">
              <span
                className={`qp-decision qp-decision-${candidate.review.decision}`}
              >
                {decisionLabels[candidate.review.decision]}
              </span>
              {candidate.review.reason}
            </p>
            <button
              type="button"
              className="qp-detail-toggle"
              disabled={busy}
              aria-expanded={!!expanded[candidate.id]}
              aria-controls={detailsId}
              onClick={() =>
                setExpanded((current) => ({
                  ...current,
                  [candidate.id]: !current[candidate.id],
                }))
              }
            >
              {expanded[candidate.id] ? '收起依据' : '为什么选这题'}
              <ChevronDown size={14} />
            </button>
          </div>
        </div>
        {expanded[candidate.id] && (
          <div className="qp-question-details" id={detailsId}>
            <dl>
              <div>
                <dt>用户想解决什么</dt>
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
            </dl>
            {associated.length > 0 && (
              <div className="qp-assets">
                <span className="qp-detail-label">对应的已有内容</span>
                {associated.map((asset) => (
                  <button
                    type="button"
                    key={asset.id}
                    disabled={busy}
                    onClick={() => onAsset(asset)}
                  >
                    <FileText size={14} />
                    {asset.title}
                  </button>
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
                <span className="qp-detail-label">还需要注意</span>
                <ul>
                  {candidate.review.concerns.map((concern, index) => (
                    <li key={index}>{concern}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="qp-demand-note">
              需求来源尚未核实。这是一道候选问题，不代表已经观察到真实用户这样提问。
            </p>
          </div>
        )}
      </article>
    );
  }

  return (
    <div className="qp-panel og-modal-body" aria-busy={busy}>
      <header className="qp-heading">
        <div>
          <span className="og-eyebrow">下一轮搜索</span>
          <p>从品牌、实际能力和已有内容出发，选出值得测的问题。</p>
        </div>
        <span className="og-tag neutral">
          {plan.source === 'model' ? 'AI 拟题与审核' : '已整理题单'}
        </span>
      </header>

      <section className="qp-positioning">
        <label htmlFor="qp-positioning">用一小段话说明产品定位</label>
        <textarea
          id="qp-positioning"
          value={positioning}
          maxLength={1000}
          rows={3}
          disabled={busy}
          onChange={(event) => setPositioning(event.target.value)}
        />
        <p className="qp-help">
          定位用于判断问题是否相关，不保证搜索时一定出现。题目要符合实际能力，文章也有自己的发现问题。
        </p>
        {modelConfigured ? (
          <div className="qp-generate-row">
            <button
              type="button"
              className="og-button secondary"
              disabled={busy || !positioning.trim()}
              onClick={() => void onGenerate(positioning.trim())}
            >
              {busy ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <Sparkles size={15} />
              )}
              AI 拟题并审核
            </button>
            <span className="qp-help">
              将调用已配置模型两次，可能产生模型费用。
            </span>
          </div>
        ) : (
          <p className="qp-help qp-model-note">
            当前可以选择已整理的问题。启用模型后，可按定位重新拟题并审核。
          </p>
        )}
        {positioningChanged && (
          <div className="qp-positioning-change" role="status">
            <span>定位已修改，重新拟题后才能确认这版题单。</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => setPositioning(plan.positioning)}
            >
              恢复已保存定位
            </button>
          </div>
        )}
      </section>

      <section className="qp-questions" aria-label="候选问题">
        <div className="qp-list-heading">
          <div>
            <h3>选择下一轮要测的问题</h3>
            <p className="qp-help">
              已选 {selected.length} 题 · 候选问题尚未采集搜索结果
            </p>
          </div>
          <label className="qp-filter">
            <span>类别</span>
            <select
              aria-label="按问题类别筛选"
              disabled={busy}
              value={category}
              onChange={(event) => {
                setCategory(event.target.value as QuestionCategory | 'all');
                setShowAll(false);
              }}
            >
              <option value="all">全部类别</option>
              {(
                Object.entries(QUESTION_CATEGORY_LABELS) as [
                  QuestionCategory,
                  string,
                ][]
              ).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="qp-list">
          {visibleRecommended.map(renderCandidate)}
          {!recommended.length && (
            <p className="qp-empty">
              这个类别暂无已选或推荐问题，可查看下方待探索题。
            </p>
          )}
        </div>
        {recommended.length > 5 && (
          <button
            type="button"
            className="qp-show-more"
            disabled={busy}
            onClick={() => setShowAll(!showAll)}
          >
            {showAll
              ? '收起更多问题'
              : `查看其余 ${recommended.length - 5} 道推荐或已选问题`}
            <ChevronDown size={14} />
          </button>
        )}
        {exploratory.length > 0 && (
          <section className="qp-secondary-group">
            <button
              type="button"
              className="qp-group-toggle"
              disabled={busy}
              aria-expanded={showExplore}
              aria-controls="qp-exploratory"
              onClick={() => setShowExplore(!showExplore)}
            >
              <span>
                待探索的问题 <small>{exploratory.length}</small>
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
              disabled={busy}
              aria-expanded={showExcluded}
              aria-controls="qp-excluded"
              onClick={() => setShowExcluded(!showExcluded)}
            >
              <span>
                暂不测的问题与原因 <small>{excluded.length}</small>
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
      {plan.notes.length > 0 && (
        <aside className="qp-plan-notes" aria-label="题单说明">
          {plan.notes.map((note, index) => (
            <p key={index}>{note}</p>
          ))}
        </aside>
      )}
      <footer className="qp-footer">
        <div>
          <p className="qp-save-state" role="status">
            {busy ? (
              <Loader2 size={15} className="spin" />
            ) : plan.status === 'ready' ? (
              <Check size={15} />
            ) : null}
            {busy
              ? '正在处理…'
              : plan.status === 'ready'
                ? '已保存，尚未采集搜索结果'
                : `已选 ${selected.length} 题，等待确认`}
          </p>
          <p className="qp-help">
            版本 {plan.revision} · {plan.status === 'ready' ? '已确认' : '草稿'}{' '}
            · 确认题单不会启动搜索，历史题单保留。
          </p>
        </div>
        <div className="qp-footer-actions">
          <button
            type="button"
            className="og-text-button"
            disabled={busy || !selected.length || positioningChanged}
            onClick={downloadPlan}
          >
            <Download size={14} />
            导出题单
          </button>
          <button
            type="button"
            className="og-button primary"
            disabled={
              busy ||
              !selected.length ||
              positioningChanged ||
              plan.status === 'ready'
            }
            onClick={() => void onConfirm()}
          >
            {plan.status === 'ready' ? '题单已确认' : '确认下轮题单'}
          </button>
          {plan.status === 'ready' && onContinue && (
            <button
              type="button"
              className="og-button primary"
              disabled={busy || positioningChanged}
              onClick={onContinue}
            >
              进入任务，选择搜索方式
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

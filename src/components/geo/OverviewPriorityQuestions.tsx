'use client';

import { useState } from 'react';
import { ArrowRight, ChevronDown, ChevronUp } from 'lucide-react';
import type {
  ResearchQuestion,
  ResearchEngine,
} from '@/lib/geo/research-types';
import {
  isAiAnswerRow,
  summarizeMetric,
  type AuditedResearchRow,
} from '@/lib/geo/overview-metrics';
import { RESEARCH_ENGINE_NAMES } from '@/lib/geo/research-engines';
import OverviewActionPreview from './OverviewActionPreview';
import './overview-priority-questions.css';
import OverviewPrioritySort from './OverviewPrioritySort';
import { useOverviewOrder } from './useOverviewOrder';

type Props = {
  projectId: string;
  allQuestionIds: string[];
  questions: ResearchQuestion[];
  rows: AuditedResearchRow[];
  language: 'zh' | 'en';
  onQuestion: (question: ResearchQuestion, engine?: ResearchEngine) => void;
  onPlan?: (question: ResearchQuestion, language: 'zh' | 'en', engine: ResearchEngine) => Promise<void>;
  previewOnly?: boolean;
};

function collectionDate(value: string | undefined, compact: boolean): string {
  if (!value) return '时间待核实';
  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp))
    return new Date(timestamp)
      .toLocaleDateString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: compact ? undefined : 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
      .replaceAll('/', '-');
  const date = value.match(/\d{4}-(\d{2}-\d{2})/);
  return date?.[compact ? 1 : 0] ?? '时间待核实';
}

export default function OverviewPriorityQuestions({
  projectId,
  allQuestionIds,
  questions,
  rows,
  language,
  onQuestion,
  onPlan,
  previewOnly = false,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<ResearchQuestion | null>(null);
  const [planning, setPlanning] = useState<string | null>(null);
  const { orderedQuestions, ready, saving, error, reorder } = useOverviewOrder(projectId, questions, allQuestionIds, previewOnly);
  const visible = expanded ? orderedQuestions : orderedQuestions.slice(0, 3);
  const singlePlatform = new Set(rows.map((row) => row.engine)).size === 1;
  const actionFor = (question: ResearchQuestion) =>
    question.diagnosis.nextStep || '核对回答依据，找到值得优先补齐的内容';

  return (
    <div className="pov-priorities">
      {previewOnly && <div className="pov-priorities-notice">
        <span>样式预览</span>行动内容仅用于预览，尚未生成或审核方案
      </div>}
      <OverviewPrioritySort key={visible.map(question => question.id).sort().join('|')}
        items={visible} disabled={!ready || saving || previewOnly || planning !== null}
        onReorder={reorder} renderItem={(question, index, handle) => (
          <article
            className={`pov-priority-item${index === 0 ? ' is-first' : ''}`}
            key={question.id}
          >
            <div className="pov-priority-content">
              {handle}
              <div className="pov-priority-copy">
                <button
                  type="button"
                  className="pov-priority-title"
                  onClick={() => onQuestion(question)}
                >
                  {question[language]}
                </button>
                <p className="pov-priority-reason" title={question.valueReason}>
                  {question.valueReason}
                </p>
                <div className="pov-priority-evidence">
                  {rows
                    .filter((row) => row.question.id === question.id)
                    .map((row) => {
                      const ai = isAiAnswerRow(row);
                      const mention = summarizeMetric([row], 'mention');
                      const citation = summarizeMetric([row], 'citation');
                      const found = ai
                        ? mention.yes > 0
                        : row.observation?.status === 'found';
                      const status = !row.observation
                        ? '未测'
                        : ai && mention.unknown
                          ? '待核实'
                          : found
                            ? ai
                              ? '已提及'
                              : '已找到'
                            : ai
                              ? '未提及'
                              : '本次未见';
                      const citationStatus = !row.observation
                        ? '未测'
                        : citation.unknown
                          ? '待核实'
                          : citation.yes
                            ? '已引用'
                            : '未引用';
                      const collectedAt =
                        row.observation?.collectedAt ||
                        row.observation?.recordedAt;
                      const details = [
                        RESEARCH_ENGINE_NAMES[row.engine],
                        ai
                          ? `AI 正文提及：${status}；自有内容引用：${citationStatus}`
                          : `网页搜索官方来源：${status}`,
                        row.observation
                          ? `采集时间：${collectedAt || '待核实'}`
                          : '尚未采集',
                      ].join(' · ');
                      return (
                        <button
                          type="button"
                          key={row.key}
                          className={`pov-priority-evidence-link${found ? ' is-found' : ''}`}
                          title={details}
                          aria-label={`${question[language]} · ${details}`}
                          onClick={() => onQuestion(question, row.engine)}
                        >
                          <span
                            className="pov-priority-dot"
                            aria-hidden="true"
                          />
                          {RESEARCH_ENGINE_NAMES[row.engine]}
                          <span className="pov-priority-evidence-status">
                            {status}
                          </span>
                          {ai && singlePlatform && (
                            <span className="pov-priority-evidence-status">
                              自有引用：{citationStatus}
                            </span>
                          )}
                          {row.observation && (
                            <small className="pov-priority-evidence-date">
                              {collectionDate(collectedAt, !singlePlatform)}
                            </small>
                          )}
                        </button>
                      );
                    })}
                </div>
              </div>
            </div>
            <div className="pov-priority-next">
              <div>
                <span className="pov-priority-next-label">建议方向</span>
                <p title={actionFor(question)}>{actionFor(question)}</p>
              </div>
              <button
                type="button"
                className={`pov-priority-action${index === 0 ? ' is-primary' : ''}`}
                disabled={!previewOnly && (planning !== null || !onPlan || !rows.some(row => row.question.id === question.id && row.observation && ['chatgpt', 'deepseek'].includes(row.engine)))}
                title={!previewOnly && !rows.some(row => row.question.id === question.id && row.observation && ['chatgpt', 'deepseek'].includes(row.engine)) ? '暂未接入该平台的保存证据；当前支持 ChatGPT 回答和 DeepSeek 搜索原文。' : undefined}
                onClick={async () => {
                  if (previewOnly) { setPreview(question); return; }
                  const candidates = rows.filter(row => row.question.id === question.id && row.observation && ['chatgpt', 'deepseek'].includes(row.engine));
                  const selected = candidates.find(row => isAiAnswerRow(row)) ?? candidates[0];
                  if (!selected || !onPlan) return;
                  setPlanning(question.id);
                  try { await onPlan(question, language, selected.engine); }
                  finally { setPlanning(null); }
                }}
              >
                {previewOnly ? '预览改进方案' : planning === question.id ? '正在准备…' : '制定改进方案'} <ArrowRight size={14} />
              </button>
            </div>
          </article>
        )} />
      {error && <p className="pov-sort-error" role="alert">{error}</p>}
      {questions.length > 3 && (
        <button
          type="button"
          className="pov-priority-expand"
          aria-expanded={expanded}
          aria-controls="pov-priority-list"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? '收起，保留前三条'
            : `展开其余 ${questions.length - 3} 个问题`}
          {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
      )}
      {preview && (
        <OverviewActionPreview
          question={preview[language]}
          action={actionFor(preview)}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

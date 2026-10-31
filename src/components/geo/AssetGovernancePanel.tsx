'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Plus } from 'lucide-react';
import type {
  AssetGovernanceInput,
  GeoState,
  ResearchTaskContext,
} from '@/lib/geo/types';
import type { ContentGovernanceItem } from '@/lib/geo/content-assets';
import { contentWebUrl } from './ContentEvidence';
import { displayTaskTitle } from './question-labels';
import GeoSelect from './GeoSelect';

const statusNames = {
  open: '待核查',
  investigating: '核查中',
  resolved: '已登记解决',
};
const taskNames: Record<string, string> = {
  queued: '待开始',
  investigating: '调查中',
  proposal_ready: '方案待审阅',
  awaiting_implementation: '待实施',
  monitoring: '跟测中',
  paused: '已暂停',
  completed: '已完成',
  failed: '执行失败',
};

export default function AssetGovernancePanel({
  gap,
  data,
  language,
  engine,
  onImprove,
  onGovernance,
  onOpenTask,
}: {
  gap: ContentGovernanceItem;
  data: GeoState;
  language: 'zh' | 'en';
  engine: 'chatgpt' | 'google';
  onImprove?: (context: ResearchTaskContext) => void;
  onGovernance?: (input: AssetGovernanceInput) => Promise<void> | void;
  onOpenTask?: (id: string) => void;
}) {
  const selectPortal = useRef<HTMLElement>(null);
  const record = data.governanceRecords?.find(
    (entry) =>
      entry.projectId === gap.projectId &&
      entry.batchId === gap.batchId &&
      entry.gapId === gap.id,
  );
  const [status, setStatus] = useState<'open' | 'investigating' | 'resolved'>(
    record?.status || 'open',
  );
  const [note, setNote] = useState('');
  const [url, setUrl] = useState('');
  const [resolution, setResolution] = useState(record?.resolution || '');
  const [taskId, setTaskId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const tasks = data.tasks.filter((task) => task.projectId === gap.projectId);
  const linked = tasks.filter(
    (task) =>
      record?.taskIds.includes(task.id) ||
      (task.researchContext?.batchId === gap.batchId &&
        task.researchContext?.gapId === gap.id),
  );
  const availableTasks = tasks.filter(
    (task) =>
      !linked.some((entry) => entry.id === task.id) &&
      (!task.researchContext ||
        (task.researchContext.batchId === gap.batchId &&
          task.researchContext.questionId === gap.question.id)),
  );
  const hasEvidence = Boolean(record?.evidence.length || note.trim());

  useEffect(() => {
    setStatus(record?.status || 'open');
    setResolution(record?.resolution || '');
  }, [record?.updatedAt, record?.status, record?.resolution]);

  async function save(input: Partial<AssetGovernanceInput>) {
    if (!onGovernance) return;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await onGovernance({
        batchId: gap.batchId,
        questionId: gap.question.id,
        gapId: gap.id,
        ...input,
      });
      setSaved(true);
      if (input.evidence) {
        setNote('');
        setUrl('');
      }
      if (input.taskIds) setTaskId('');
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : '核查记录未保存，请重试。',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ka-governance" ref={selectPortal}>
      <div className="ka-governance-heading">
        <h3>核查进度</h3>
        <span className={'ka-governance-status ' + (record?.status || 'open')}>
          {statusNames[record?.status || 'open']}
        </span>
      </div>
      <div className="ka-governance-actions">
        {onImprove && (
          <button
            className="ka-primary"
            onClick={() =>
              onImprove({
                batchId: gap.batchId,
                questionId: gap.question.id,
                language,
                engine,
                purpose: 'investigate_gap',
                gapId: gap.id,
                gap: gap.raw,
              })
            }
          >
            <Plus size={14} />
            {linked.length ? '新建核查任务' : '开始核查'}
          </button>
        )}
        {!onImprove && onGovernance && (
          <button
            className="ka-primary"
            disabled={busy}
            onClick={() => save({ status: 'investigating' })}
          >
            开始核查
          </button>
        )}
        {gap.question.decision === 'keep_and_fill' && (
          <small>先补材料 · 不启动搜索</small>
        )}
      </div>
      {linked.length > 0 && (
        <div className="ka-linked-tasks">
          {linked.map((task) => (
            <button
              key={task.id}
              disabled={!onOpenTask}
              onClick={() => onOpenTask?.(task.id)}
            >
              <span>
                <strong>{displayTaskTitle(task, data)}</strong>
                <small>
                  {taskNames[task.status] || task.status}
                  {task.events.at(-1)?.title
                    ? ' · ' + task.events.at(-1)?.title
                    : ''}
                </small>
              </span>
              <ArrowUpRight size={14} />
            </button>
          ))}
        </div>
      )}
      {onGovernance && availableTasks.length > 0 && (
        <details className="ka-associate-task">
          <summary>关联已有任务</summary>
          <div>
            <GeoSelect
              label="选择要关联的任务"
              value={taskId}
              onChange={setTaskId}
              portalTarget={selectPortal}
              options={[
                { value: '', label: '选择任务' },
                ...availableTasks.map((task) => ({
                  value: task.id,
                  label: displayTaskTitle(task, data),
                })),
              ]}
            />
            <button
              disabled={!taskId || busy}
              onClick={() =>
                save({
                  taskIds: [taskId],
                  status:
                    record?.status === 'resolved'
                      ? 'resolved'
                      : 'investigating',
                })
              }
            >
              关联
            </button>
          </div>
        </details>
      )}
      {record?.evidence.length ? (
        <details className="ka-governance-evidence">
          <summary>核查证据 · {record.evidence.length}</summary>
          {record.evidence.map((entry) => (
            <article key={entry.id}>
              <p>{entry.note}</p>
              {contentWebUrl(entry.url || null) && (
                <a
                  href={contentWebUrl(entry.url || null)!}
                  target="_blank"
                  rel="noreferrer"
                >
                  {entry.url}
                  <ArrowUpRight size={12} />
                </a>
              )}
              <time>
                {new Date(entry.at).toLocaleString('zh-CN', { hour12: false })}
              </time>
            </article>
          ))}
        </details>
      ) : null}
      {record?.resolution && (
        <div className="ka-saved-resolution">
          <h4>核查结果</h4>
          <p>{record.resolution}</p>
        </div>
      )}
      {onGovernance && (
        <details className="ka-governance-editor">
          <summary>更新核查记录</summary>
          <form
            className="ka-governance-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (url.trim() && !contentWebUrl(url.trim())) {
                setError('证据链接须为完整的 http 或 https 网址。');
                return;
              }
              if (url.trim() && !note.trim()) {
                setError('请说明这条证据支持什么判断。');
                return;
              }
              if (
                status === 'resolved' &&
                (!hasEvidence || !resolution.trim())
              ) {
                setError('登记解决需要补充证据和明确的核查结果。');
                return;
              }
              void save({
                status,
                ...(note.trim()
                  ? {
                      evidence: {
                        note: note.trim(),
                        ...(url.trim() ? { url: url.trim() } : {}),
                      },
                    }
                  : {}),
                ...(resolution.trim() ? { resolution: resolution.trim() } : {}),
              });
            }}
          >
            <label>
              补充证据
              <textarea
                aria-label="补充证据说明"
                placeholder="材料与核查结果"
                value={note}
                onChange={(event) => {
                  setNote(event.target.value);
                  setSaved(false);
                }}
                rows={2}
              />
            </label>
            <label>
              证据链接（可选）
              <input
                aria-label="证据链接"
                type="url"
                placeholder="https://…"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setSaved(false);
                }}
              />
            </label>
            <div className="ka-governance-outcome">
              <label>
                核查状态
                <GeoSelect
                  label="核查状态"
                  value={status}
                  onChange={(value) => {
                    setStatus(value);
                    setSaved(false);
                  }}
                  portalTarget={selectPortal}
                  options={[
                    { value: 'open', label: '待核查' },
                    { value: 'investigating', label: '核查中' },
                    { value: 'resolved', label: '已解决' },
                  ]}
                />
              </label>
            </div>
            {(status === 'resolved' || resolution) && (
              <label>
                核查结果
                <textarea
                  aria-label="核查结果"
                  placeholder="说明缺口如何补齐、适用范围和仍存在的限制"
                  value={resolution}
                  onChange={(event) => {
                    setResolution(event.target.value);
                    setSaved(false);
                  }}
                  rows={2}
                />
              </label>
            )}
            {status === 'resolved' && !hasEvidence && (
              <p className="ka-muted">补充核查证据后才能登记解决。</p>
            )}
            <div className="ka-governance-submit">
              <button
                type="submit"
                className="ka-primary"
                disabled={
                  busy ||
                  (status === 'resolved' &&
                    (!hasEvidence || !resolution.trim()))
                }
              >
                {busy ? '保存中…' : '保存核查记录'}
              </button>
              {saved && (
                <span role="status">
                  <Check size={13} />
                  已保存
                </span>
              )}
            </div>
          </form>
        </details>
      )}
      {error && (
        <p className="ka-governance-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

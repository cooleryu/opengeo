'use client';

import { useState } from 'react';
import { ArrowRight, ChevronDown, FileText } from 'lucide-react';
import type { GeoQuestion, GeoRun, GeoTask } from '@/lib/geo/types';
import { validateImplementationDate } from '@/lib/geo/implementation';
import './tracking.css';

export const trackingDate = (value: string | null | undefined) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '未记录';

export const trackingLanguage = (value: string) =>
  ({ zh: '中文', en: '英文' })[value] || value || '语言未记录';

/** This is a record inventory, not an assertion that a run is comparable. */
export function realFollowupRuns(task: GeoTask): GeoRun[] {
  if (task.implementation?.kind !== 'user_confirmed') return [];
  let implementedAt: number;
  try {
    implementedAt = Date.parse(
      validateImplementationDate(
        task.implementation.occurredAt,
        task.implementation.at,
      ),
    );
  } catch {
    return [];
  }
  return task.runs
    .filter(
      (run) =>
        run.mode === 'live' &&
        run.phase !== 'baseline' &&
        run.id !== task.workflow?.baseline?.id &&
        Date.parse(run.at) >= implementedAt &&
        Date.parse(run.measurementAt) >= implementedAt,
    )
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * evaluateOutcome on the server owns comparability. Read its saved selection;
 * do not recreate a looser version of the protocol/learning rules in the UI.
 */
export function comparableChartRuns(task: GeoTask): GeoRun[] {
  const workflow = task.workflow;
  const outcome = workflow?.outcome;
  const baseline = workflow?.baseline;
  try {
    validateImplementationDate(
      task.implementation?.occurredAt,
      task.implementation?.at || '',
    );
  } catch {
    return [];
  }
  if (
    !outcome ||
    outcome.classification === 'inconclusive' ||
    outcome.beforeRate === null ||
    outcome.afterRate === null ||
    !baseline ||
    baseline.id !== outcome.baselineRunId ||
    task.implementation?.kind !== 'user_confirmed' ||
    !task.implementation.proposalRevision ||
    task.implementation.proposalRevision !== workflow.proposalRevision ||
    !outcome.followupRunIds.length
  )
    return [];
  const selected = outcome.followupRunIds.map((id) =>
    task.runs.find((run) => run.id === id),
  );
  if (selected.some((run) => !run)) return [];
  return [baseline, ...(selected as GeoRun[])];
}

export function observationLabel(question: GeoQuestion, answers: boolean) {
  return answers
    ? question.aiCited === true
      ? '已引用'
      : question.aiCited === false
        ? '本次未引用'
        : '未确认'
    : question.projectHit
      ? '已找到'
      : '本次未见';
}

type Observation = { run: GeoRun; question: GeoQuestion };
type Selection = { key: string; phase: 'before' | 'after' };

export default function TaskOutcomeHistory({
  task,
  onEvidence,
  compact = false,
}: {
  task: GeoTask;
  onEvidence: (path: string) => void;
  compact?: boolean;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const outcome = task.workflow?.outcome;
  const comparable = comparableChartRuns(task);
  const answers =
    task.workflow?.collection?.metric === 'answer_target_citation';
  const metric = answers ? '回答目标引用率' : '搜索结果命中率';
  const before = comparable[0];
  const after = comparable.slice(1);
  const groups = new Map<
    string,
    {
      provider: string;
      language: string;
      before: Observation[];
      after: Observation[];
    }
  >();
  for (const [phase, runs] of [
    ['before', before ? [before] : []],
    ['after', after],
  ] as const) {
    for (const run of runs) {
      for (const question of run.questions) {
        const key = JSON.stringify([question.provider, question.language]);
        const group = groups.get(key) || {
          provider: question.provider,
          language: question.language,
          before: [],
          after: [],
        };
        group[phase].push({ run, question });
        groups.set(key, group);
      }
    }
  }
  const count = (items: Observation[]) =>
    items.filter(({ question }) =>
      answers ? question.aiCited === true : question.projectHit,
    ).length;
  const selectedGroup = selection ? groups.get(selection.key) : undefined;
  const selectedRecords =
    selectedGroup && selection ? selectedGroup[selection.phase] : [];
  const noResult =
    task.implementation?.kind === 'rehearsal'
      ? '演练未产生真实效果'
      : !task.implementation
        ? '尚未登记实际实施'
        : !task.implementation.occurredAt
          ? '实际实施时间尚未记录'
          : !task.workflow?.outcome
            ? '尚未形成可比效果复盘'
            : '当前记录不足以比较效果';
  return (
    <section className="og-tracking-outcome" aria-label="实施前后可比观测">
      <header className="og-tracking-section-heading">
        <h3>实施前后</h3>
        <span>{metric}</span>
      </header>
      {comparable.length ? (
        <>
          <div className="og-tracking-comparison">
            <div className="og-tracking-comparison-head" aria-hidden="true">
              <span>平台 · 语言</span>
              <span>实施前</span>
              <span>实施后</span>
            </div>
            {[...groups].map(([key, group]) => (
              <div key={key} className="og-tracking-comparison-row">
                <div>
                  <strong>{group.provider}</strong>
                  <span>{trackingLanguage(group.language)}</span>
                </div>
                {(['before', 'after'] as const).map((phase) => {
                  const items = group[phase];
                  const hits = count(items);
                  return (
                    <button
                      key={phase}
                      type="button"
                      className="og-tracking-number"
                      aria-expanded={
                        selection?.key === key && selection.phase === phase
                      }
                      aria-label={`${group.provider} ${trackingLanguage(group.language)} ${phase === 'before' ? '实施前' : '实施后'} ${hits}/${items.length} 条观测，查看逐题记录`}
                      onClick={() =>
                        setSelection(
                          selection?.key === key && selection.phase === phase
                            ? null
                            : { key, phase },
                        )
                      }
                    >
                      <strong>
                        {hits}
                        <small> / {items.length}</small>
                      </strong>
                      <span>
                        {items.length
                          ? `${((hits / items.length) * 100).toFixed(1)}%`
                          : '未测'}
                        <ArrowRight size={13} />
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="og-tracking-comparison-meta">
            <span>实施前 1 轮 · 实施后 {after.length} 轮</span>
            <details className="og-tracking-metric-help">
              <summary>
                统计口径
                <ChevronDown size={12} />
              </summary>
              <p>分母为各轮问题观测数。平台与语言分别比较。</p>
            </details>
          </div>
          {selectedGroup && selection && (
            <div className="og-tracking-selected" aria-live="polite">
              <header>
                <strong>
                  {selectedGroup.provider} ·{' '}
                  {trackingLanguage(selectedGroup.language)} ·{' '}
                  {selection.phase === 'before' ? '实施前' : '实施后'}
                </strong>
                <button
                  type="button"
                  className="og-tracking-link"
                  onClick={() => setSelection(null)}
                >
                  收起
                </button>
              </header>
              <div className="og-tracking-observations">
                {selectedRecords.map(({ run, question }) => (
                  <div key={`${run.id}-${question.id}`}>
                    <div>
                      <span>{question.query}</span>
                      <small>{trackingDate(question.measurementAt)}</small>
                    </div>
                    <span
                      className={
                        answers
                          ? question.aiCited === true
                            ? 'observed'
                            : ''
                          : question.projectHit
                            ? 'observed'
                            : ''
                      }
                    >
                      {observationLabel(question, answers)}
                    </span>
                    {question.evidencePath && (
                      <button
                        type="button"
                        className="og-tracking-link"
                        onClick={() => onEvidence(question.evidencePath)}
                      >
                        <FileText size={13} />
                        原记录
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="og-tracking-empty">
          <strong>{noResult}</strong>
          <details className="og-tracking-disclosure">
            <summary>
              比较条件
              <ChevronDown size={14} />
            </summary>
            <div>
              <p>
                {task.implementation?.kind === 'rehearsal'
                  ? '回放记录保留在历史中。'
                  : task.implementation?.kind === 'user_confirmed' &&
                      !task.implementation.occurredAt
                    ? '补充实际发生时间后，才能区分实施前后观测。'
                    : '实施前基线与实施后复测未满足当前版本的比较条件。'}
              </p>
            </div>
          </details>
        </div>
      )}
      {!compact && outcome && (
        <details className="og-tracking-disclosure">
          <summary>
            复盘依据<span>{trackingDate(outcome.evaluatedAt)}</span>
            <ChevronDown size={14} />
          </summary>
          <div>
            <p>{outcome.summary}</p>
            <ul>
              {outcome.limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
            <div className="og-tracking-evidence">
              {outcome.evidencePaths.map((path) => (
                <button
                  key={path}
                  type="button"
                  className="og-tracking-link"
                  onClick={() => onEvidence(path)}
                >
                  <FileText size={13} />
                  {path.split('/').slice(-2).join('/')}
                </button>
              ))}
            </div>
          </div>
        </details>
      )}
    </section>
  );
}

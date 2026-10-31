'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import Markdown from 'markdown-to-jsx';
import {
  ArrowDownRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Pause,
  Play,
  RotateCcw,
} from 'lucide-react';
import type { GeoTask } from '@/lib/geo/types';
import {
  buildQualityEvolution,
  type EvolutionField,
  type QualityEvolutionFrame,
} from './quality-evolution-data';
import './quality-evolution.css';

const dimensions = [
  ['evidence', '证据支撑'],
  ['relevance', '问题相关性'],
  ['actionability', '可执行性'],
  ['verifiability', '可验证性'],
] as const;
const fieldLabels: Record<EvolutionField, string> = {
  after: '正文',
  title: '任务名称',
  rationale: '为什么这样改',
  changes: '怎么修改页面',
  evidencePaths: '参考资料',
  successCriteria: '怎么检查效果',
  limitations: '注意事项',
};
const changeDescriptions: Record<EvolutionField, string> = {
  after: '正文',
  title: '任务名称',
  rationale: '修改理由',
  changes: '修改步骤',
  evidencePaths: '参考资料',
  successCriteria: '效果检查方法',
  limitations: '注意事项',
};
const joinDescriptions = (labels: string[]) =>
  labels.length > 1
    ? `${labels.slice(0, -1).join('、')}和${labels.at(-1)}`
    : (labels[0] ?? '');
const stopLabels = {
  target_reached: '达到审核目标，已停止改稿',
  no_progress: '本轮没有进步，已停止并保留较好的方案',
  round_limit: '修改轮次已用完，已停止',
  needs_configuration: '等待配置模型，尚未完成质量审核',
  needs_evidence: '证据不足，暂不能通过审核',
};
const number = (value: number) => Number(value.toFixed(1)).toString();
const deltaText = (value: number) => `${value > 0 ? '+' : ''}${number(value)}`;
const tone = (value: number | null) =>
  value === null || value === 0
    ? 'neutral'
    : value < 0
      ? 'negative'
      : 'positive';
const timestamp = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Shanghai',
  });
const asText = (value: string | string[] | null) =>
  Array.isArray(value)
    ? value.map((text, i) => `${i + 1}. ${text}`).join('\n\n')
    : (value ?? '');

function AnimatedScore({ value }: { value: number | null }) {
  const [shown, setShown] = useState(value);
  const previous = useRef(value);
  useEffect(() => {
    const from = previous.current;
    previous.current = value;
    if (
      value === null ||
      from === null ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      setShown(value);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min((now - start) / 520, 1);
      setShown(from + (value - from) * (1 - (1 - progress) ** 3));
      if (progress < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return (
    <strong aria-label={value === null ? '未评分' : `${number(value)} 分`}>
      {shown === null ? '—' : number(shown)}
    </strong>
  );
}

function ScorePlot({
  frames,
  selected,
  onSelect,
}: {
  frames: QualityEvolutionFrame[];
  selected: QualityEvolutionFrame;
  onSelect: (id: string) => void;
}) {
  const id = useId().replace(/:/g, '');
  const scored = frames.filter((frame) => frame.score !== null);
  if (!scored.length)
    return (
      <p className="og-evo-empty">
        还没有模型评分。完成审核后，这里会显示真实的评分变化。
      </p>
    );
  const values = scored.map((frame) => frame.score!);
  const floor = Math.max(
    0,
    Math.floor((Math.min(...values, selected.targetScore) - 5) / 10) * 10,
  );
  const ceiling = Math.min(
    100,
    Math.max(
      floor + 20,
      Math.ceil((Math.max(...values, selected.targetScore) + 5) / 10) * 10,
    ),
  );
  const x = (index: number) =>
    frames.length === 1 ? 340 : 64 + (index / (frames.length - 1)) * 552;
  const y = (score: number) =>
    156 - ((score - floor) / (ceiling - floor)) * 120;
  const selectedIndex = frames.findIndex((frame) => frame.id === selected.id);
  // Break the line when a review is unscored or the scoring criteria change.
  const segments: string[] = [];
  let segment = '';
  frames.forEach((frame, index) => {
    if (frame.score === null || frame.criteriaChanged) {
      if (segment) segments.push(segment);
      segment = '';
    }
    if (frame.score !== null)
      segment += `${segment ? ' L' : 'M'} ${x(index)} ${y(frame.score)}`;
  });
  if (segment) segments.push(segment);
  return (
    <svg
      className="og-evo-plot"
      viewBox="0 0 680 194"
      role="img"
      aria-label={`评分变化，纵轴 ${floor} 至 ${ceiling} 分。${scored.map((frame) => `第 ${frame.sequence} 次审核 ${number(frame.score!)} 分`).join('；')}`}
    >
      <defs>
        <linearGradient id={`${id}-line`} x1="0" x2="1">
          <stop stopColor="#7c9cff" />
          <stop offset="1" stopColor="#6ce6cf" />
        </linearGradient>
      </defs>
      {[floor, (floor + ceiling) / 2, ceiling].map((tick) => (
        <g key={tick}>
          <line
            className="og-evo-gridline"
            x1="48"
            x2="632"
            y1={y(tick)}
            y2={y(tick)}
          />
          <text
            className="og-evo-chart-label"
            x="30"
            y={y(tick) + 4}
            textAnchor="end"
          >
            {tick}
          </text>
        </g>
      ))}
      <line
        className="og-evo-threshold"
        x1="48"
        x2="632"
        y1={y(selected.targetScore)}
        y2={y(selected.targetScore)}
      />
      <text
        className="og-evo-chart-label"
        x="342"
        y={y(selected.targetScore) - 9}
        textAnchor="middle"
      >
        目标 {selected.targetScore}
      </text>
      {segments.map((path, i) => (
        <path
          className="og-evo-curve"
          key={i}
          d={path}
          fill="none"
          stroke={`url(#${id}-line)`}
          strokeWidth="3"
          strokeLinecap="round"
        />
      ))}
      {frames.map(
        (frame, index) =>
          frame.score !== null && (
            <g key={frame.id} opacity={index > selectedIndex ? 0.35 : 1}>
              {frame.id === selected.id && (
                <line
                  x1={x(index)}
                  x2={x(index)}
                  y1={y(frame.score) + 12}
                  y2="166"
                  stroke="#6ce6cf"
                  opacity=".22"
                  strokeDasharray="3 5"
                />
              )}
              <circle
                className={`og-evo-point ${frame.id === selected.id ? 'active' : ''}`}
                cx={x(index)}
                cy={y(frame.score)}
                r={frame.id === selected.id ? 6 : 4}
                fill={frame.id === selected.id ? '#8cf6df' : '#a3b5ef'}
              />
              <text
                className="og-evo-chart-score"
                x={x(index)}
                y={y(frame.score) - 15}
                textAnchor="middle"
              >
                {number(frame.score)}
              </text>
              <text
                className="og-evo-chart-label"
                x={x(index)}
                y="184"
                textAnchor="middle"
              >
                {frame.sequence === 1 ? '初审' : `审核 ${frame.sequence}`}
              </text>
              <circle
                cx={x(index)}
                cy={y(frame.score)}
                r="17"
                fill="transparent"
                role="button"
                tabIndex={0}
                aria-label={`查看第 ${frame.sequence} 次审核，${number(frame.score)} 分`}
                onClick={() => onSelect(frame.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(frame.id);
                  }
                }}
              />
            </g>
          ),
      )}
    </svg>
  );
}

function DiffText({
  text,
  other,
  side,
}: {
  text: string;
  other: string;
  side: 'before' | 'after';
}) {
  const paragraphs = text.split(/\n\s*\n/);
  const comparison = other.split(/\n\s*\n/);
  const unchanged = new Set<number>();
  // Match sequences, not sets: moved or repeated paragraphs are real changes too.
  if (paragraphs.length * comparison.length <= 160000) {
    const lengths = Array.from(
      { length: paragraphs.length + 1 },
      () => new Uint16Array(comparison.length + 1),
    );
    for (let i = paragraphs.length - 1; i >= 0; i--) {
      for (let j = comparison.length - 1; j >= 0; j--) {
        lengths[i][j] =
          paragraphs[i] === comparison[j]
            ? lengths[i + 1][j + 1] + 1
            : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
      }
    }
    let i = 0,
      j = 0;
    while (i < paragraphs.length && j < comparison.length) {
      if (paragraphs[i] === comparison[j]) {
        unchanged.add(i);
        i++;
        j++;
      } else if (lengths[i + 1][j] >= lengths[i][j + 1]) i++;
      else j++;
    }
  } else {
    paragraphs.forEach((paragraph, i) => {
      if (paragraph === comparison[i]) unchanged.add(i);
    });
  }
  return (
    <div className="og-evo-diff-text">
      {text ? (
        paragraphs.map((paragraph, index) => {
          const changed = !unchanged.has(index);
          return (
            <div
              key={index}
              className={`og-evo-line ${changed ? (side === 'after' ? 'added' : 'deleted') : 'same'}`}
            >
              <Markdown
                options={{ disableParsingRawHTML: true, forceBlock: true }}
              >
                {paragraph}
              </Markdown>
            </div>
          );
        })
      ) : (
        <p className="og-muted">无内容</p>
      )}
    </div>
  );
}

export default function QualityEvolution({
  task,
  approved,
  dirty,
}: {
  task: GeoTask;
  approved: boolean;
  dirty: boolean;
}) {
  const evolution = useMemo(() => buildQualityEvolution(task), [task]);
  const { frames, retainedFrameId } = evolution;
  const defaultId = retainedFrameId ?? frames.at(-1)?.id ?? '';
  const [selectedId, setSelectedId] = useState(defaultId);
  const [playing, setPlaying] = useState(false);
  const [field, setField] = useState('');
  const [expanded, setExpanded] = useState(false);
  const signature = frames.map((frame) => frame.id).join('|');
  useEffect(() => {
    setSelectedId(defaultId);
    setPlaying(false);
  }, [task.id, signature, defaultId]);
  const selected =
    frames.find((frame) => frame.id === selectedId) ??
    frames.find((frame) => frame.id === defaultId) ??
    frames.at(-1);
  useEffect(() => {
    setField('');
    setExpanded(false);
  }, [selected?.id]);
  useEffect(() => {
    if (!playing || !selected) return;
    const index = frames.findIndex((frame) => frame.id === selected.id);
    const timer = setTimeout(() => {
      if (index >= frames.length - 1) setPlaying(false);
      else setSelectedId(frames[index + 1].id);
    }, 2200);
    return () => clearTimeout(timer);
  }, [playing, selected?.id, signature]);
  const select = (id: string) => {
    setPlaying(false);
    setSelectedId(id);
  };
  if (!selected)
    return (
      <section className="og-evolution og-evo-empty">
        <strong>等待第一份审核记录</strong>
        <p>有了候选稿与审核结果，就能在这里对照每次修改和最终保留的方案。</p>
      </section>
    );
  const previous = frames.find(
    (frame) => frame.id === selected.previousFrameId,
  );
  const first = frames.find((frame) => frame.score !== null);
  const comparableToFirst =
    first &&
    selected.score !== null &&
    first.score !== null &&
    first.review.criteriaVersion === selected.review.criteriaVersion;
  const totalGain = comparableToFirst
    ? Math.round((selected.score! - first.score!) * 10) / 10
    : null;
  const changedFields = selected.comparison.changes.filter(
    (change) => change.changed && change.before !== null,
  );
  const preferred = [
    'after',
    'successCriteria',
    'changes',
    'rationale',
    'limitations',
    'title',
    'evidencePaths',
  ];
  const visibleChanges = selected.comparison.changes.filter(
    (change) => change.field === 'after' || change.changed,
  );
  const activeChange =
    visibleChanges.find((change) => change.field === field) ??
    preferred
      .map((key) => changedFields.find((change) => change.field === key))
      .find(Boolean) ??
    selected.comparison.changes[0];
  const before = activeChange ? asText(activeChange.before) : '';
  const after = activeChange ? asText(activeChange.after) : '';
  const changedPlanDescriptions = joinDescriptions(
    changedFields
      .filter((change) => change.field !== 'after')
      .map((change) => changeDescriptions[change.field]),
  );
  const preview = task.workflow?.baseline?.mode === 'replay';
  const status =
    selected.score === null
      ? '尚未评分'
      : preview
        ? '历史预览'
        : selected.review.passed
          ? '该次审核通过'
          : '该次未通过';
  const remainingIssues = selected.review.issues.filter(
    (issue) => issue.severity === 'blocking',
  ).length;
  const retained = frames.find((frame) => frame.id === retainedFrameId);
  return (
    <section className="og-evolution" aria-label="方案改进过程">
      <div className="og-evo-hero">
        <div className="og-evo-heading">
          <div>
            <span className="og-evo-kicker">改进过程</span>
            <h3>每次修改，得分怎么变了？</h3>
            <p>已检查 {frames.length} 次 · 点击分数，查看那次改了什么</p>
          </div>
          {frames.length > 1 && (
            <button
              type="button"
              className="og-evo-replay"
              onClick={() => {
                if (playing) setPlaying(false);
                else {
                  setSelectedId(frames[0].id);
                  setPlaying(true);
                }
              }}
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}{' '}
              {playing ? '暂停回放' : '回放改进'}
            </button>
          )}
        </div>
        <div className="og-evo-dashboard">
          <div className="og-evo-overview">
            <div className="og-evo-score">
              <span>第 {selected.sequence} 次审核</span>
              <AnimatedScore value={selected.score} />
              <small>/ 100</small>
            </div>
            <div className={`og-evo-gain ${tone(totalGain)}`}>
              <strong>
                {totalGain === null
                  ? '待比较'
                  : totalGain === 0
                    ? selected.id === first?.id
                      ? '起点'
                      : '持平'
                    : `${deltaText(totalGain)} 分`}
              </strong>
              <p>
                {selected.score === null || !first
                  ? '等待模型审核评分'
                  : selected.id === first?.id
                    ? '这份稿子的首次评分'
                    : comparableToFirst
                      ? '相较首次评分'
                      : '评分口径不同，不计算增减'}
              </p>
            </div>
            <span
              className={`og-evo-status ${selected.review.passed && !preview && selected.score !== null ? '' : 'pending'}`}
            >
              {selected.review.passed &&
                !preview &&
                selected.score !== null && <Check size={13} />}{' '}
              {status}
            </span>
          </div>
          <div className="og-evo-plot-wrap">
            <ScorePlot frames={frames} selected={selected} onSelect={select} />
          </div>
        </div>
        <div className="og-evo-rounds" aria-label="选择审核记录">
          {frames.map((frame) => (
            <button
              type="button"
              key={frame.id}
              className={frame.id === selected.id ? 'active' : ''}
              aria-pressed={frame.id === selected.id}
              onClick={() => select(frame.id)}
            >
              <span>
                {frame.sequence === 1
                  ? '初次审核'
                  : `第 ${frame.sequence} 次审核`}
              </span>
              <strong>
                {frame.score === null ? '未评分' : `${number(frame.score)} 分`}
              </strong>
              <small>
                {frame.isRetained
                  ? '当前保留'
                  : timestamp(frame.review.reviewedAt)}
              </small>
            </button>
          ))}
        </div>
        <div className="og-evo-dimensions">
          {dimensions.map(([key, label]) => {
            const score =
              selected.score === null ? null : selected.review.scores[key];
            const delta = selected.dimensionDeltas?.[key] ?? null;
            const old = delta === null || score === null ? null : score - delta;
            return (
              <div className="og-evo-dimension" key={key}>
                <div>
                  <span>{label}</span>
                  <strong>{score === null ? '—' : number(score)}</strong>
                </div>
                <div className="og-evo-track">
                  <b style={{ width: `${score ?? 0}%` }} />
                  {old !== null && <i style={{ left: `${old}%` }} />}
                </div>
                <small className={`og-evo-delta ${tone(delta)}`}>
                  {delta === null ? (
                    score === null ? (
                      '尚未评分'
                    ) : (
                      '本次评分'
                    )
                  ) : delta === 0 ? (
                    '与改前稿持平'
                  ) : (
                    <>
                      {delta > 0 ? (
                        <ArrowUpRight size={12} />
                      ) : (
                        <ArrowDownRight size={12} />
                      )}{' '}
                      {deltaText(delta)} 较改前稿
                    </>
                  )}
                </small>
              </div>
            );
          })}
        </div>
        <p className="og-evo-footnote">
          目标 {selected.targetScore} 分 · 每项 ≥{' '}
          {selected.minimumDimensionScore} ·
          无阻塞意见才可通过。分数反映方案质量，实际效果仍需实施后观察。
          {evolution.hasMixedCriteria && ' 不同评分口径之间已断开连线。'}
        </p>
      </div>
      <div className="og-evo-detail">
        <div className="og-evo-detail-heading">
          <h4>
            {selected.comparison.kind === 'original'
              ? '第一稿，相比原文改了什么？'
              : '这一轮，具体改了什么？'}
          </h4>
          <span>{selected.isRetained ? '当前保留方案' : '历史稿 · 只读'}</span>
        </div>
        <p className="og-evo-summary">
          {selected.previousSequence &&
            selected.previousSequence !== selected.sequence - 1 &&
            `从第 ${selected.previousSequence} 次审核的保留稿继续修改。`}
          {selected.comparison.kind === 'original'
            ? selected.comparison.bodyChanged
              ? '下面是原文和建议稿的对照，标出的部分就是修改内容。'
              : '这一稿没有改动正文。修改理由和后续安排可在「其他方案内容」中查看。'
            : selected.comparison.bodyChanged
              ? `这一轮修改了正文${changedPlanDescriptions ? `，也调整了${changedPlanDescriptions}` : ''}。`
              : changedFields.length
                ? `这一轮没有再改正文，补充或调整了${changedPlanDescriptions}。`
                : '这次内容没有变化，只重新做了一次检查。'}
        </p>
        <div className="og-evo-fields" aria-label="对比修改内容">
          {visibleChanges.map((change) => (
            <button
              type="button"
              key={change.field}
              aria-pressed={activeChange?.field === change.field}
              className={`${activeChange?.field === change.field ? 'active' : ''} ${change.changed ? 'changed' : ''}`}
              onClick={() => {
                setField(change.field);
                setExpanded(false);
              }}
            >
              <span>{fieldLabels[change.field]}</span>
              <small>{change.changed ? '已修改' : '未改动'}</small>
            </button>
          ))}
        </div>
        {activeChange && (
          <>
            {!activeChange.changed && (
              <p className="og-evo-same">
                这部分与
                {selected.comparison.kind === 'original'
                  ? '原文'
                  : '修改前的稿子'}
                一致，未作修改。
              </p>
            )}
            {activeChange.changed ? (
              <div
                key={`${selected.id}-${activeChange.field}`}
                className={`og-evo-diff ${expanded ? 'expanded' : ''}`}
              >
                <div className="og-evo-diff-pane">
                  <header>
                    <span>
                      {selected.comparison.kind === 'original'
                        ? '原有内容'
                        : '修改前'}
                    </span>
                    <small>{previous && `审核 ${previous.sequence}`}</small>
                  </header>
                  <DiffText text={before} other={after} side="before" />
                </div>
                <div className="og-evo-diff-pane">
                  <header>
                    <span>
                      {selected.comparison.kind === 'original'
                        ? '建议稿'
                        : '修改后'}
                    </span>
                    <small>审核 {selected.sequence}</small>
                  </header>
                  <DiffText text={after} other={before} side="after" />
                </div>
              </div>
            ) : (
              <details className="og-evo-review">
                <summary>
                  查看正文
                  <ChevronDown size={14} />
                </summary>
                <Markdown
                  options={{ disableParsingRawHTML: true, forceBlock: true }}
                >
                  {after || '暂无内容'}
                </Markdown>
              </details>
            )}
            {activeChange.changed &&
              (before.length > 240 || after.length > 240) && (
                <button
                  type="button"
                  className="og-evo-expand"
                  aria-expanded={expanded}
                  onClick={() => setExpanded(!expanded)}
                >
                  {expanded ? '收起长内容' : '展开完整对照'}
                  <ChevronDown size={14} />
                </button>
              )}
          </>
        )}
        <details className="og-evo-review" key={`contents-${selected.id}`}>
          <summary>
            其他方案内容
            <ChevronDown size={14} />
          </summary>
          {selected.comparison.changes
            .filter((change) => change.field !== 'after')
            .map((change) => (
              <div key={change.field}>
                <h5>{fieldLabels[change.field]}</h5>
                <Markdown
                  options={{ disableParsingRawHTML: true, forceBlock: true }}
                >
                  {asText(change.after) || '暂无内容'}
                </Markdown>
              </div>
            ))}
        </details>
        <details className="og-evo-review" key={selected.id}>
          <summary>
            查看这次检查意见 ·{' '}
            {remainingIssues
              ? `${remainingIssues} 项必须解决`
              : '没有必须解决的问题'}
            <ChevronDown size={14} />
          </summary>
          <p>{selected.review.summary}</p>
          <ul>
            {selected.review.issues.map((issue, i) => (
              <li key={i}>
                <strong>
                  {issue.severity === 'blocking' ? '待解决 · ' : ''}
                  {issue.detail}
                </strong>
                <p>{issue.suggestion}</p>
              </li>
            ))}
          </ul>
        </details>
      </div>
      <div className="og-evo-footer">
        <div className="og-evo-retained">
          <strong>
            {dirty
              ? '你有未保存的改动，需重新审核'
              : retained
                ? `最终保留 · 第 ${retained.sequence} 次审核的方案${retained.score === null ? '' : ` · ${number(retained.score)} 分`}`
                : '当前方案尚无对应的有效审核'}
          </strong>
          <p>
            {task.workflow?.quality &&
              stopLabels[task.workflow.quality.stopReason]}
            。
            {task.implementation
              ? task.implementation.kind === 'rehearsal'
                ? '已记录实施演练，实际效果尚未验证。'
                : '已记录实施，效果请查看观察与复盘。'
              : approved && retained && !dirty
                ? '可以确认实施，尚未发布。'
                : '暂不放行实施。'}
          </p>
        </div>
        <a
          className="og-text-button"
          href={`#proposal-draft-${task.id}`}
          onClick={() => {
            const draft = document.getElementById(`proposal-draft-${task.id}`);
            if (draft instanceof HTMLDetailsElement) draft.open = true;
          }}
        >
          查看当前稿 <ChevronDown size={14} />
        </a>
        {selected.id !== defaultId && (
          <button
            type="button"
            className="og-text-button"
            onClick={() => select(defaultId)}
          >
            <RotateCcw size={13} />
            回到当前保留稿
          </button>
        )}
      </div>
    </section>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, CircleDashed, CircleMinus } from 'lucide-react';
import type { QuestionDetail } from '@/lib/geo/question-detail-types';
import type { ResearchEngine } from '@/lib/geo/research-types';
import CompetitorCandidates from './CompetitorCandidates';

type Props = {
  projectId: string;
  batchId: string;
  questionId: string;
  language: 'zh' | 'en';
  engine: ResearchEngine | 'all';
  history: boolean;
  revision: string;
  recordKeys: string[];
  selectedKey: string;
  onSelect: (key: string) => void;
};

/** Only renders the versioned detail response; counts are not inferred from prose. */
export default function QuestionDetailVisual(props: Props) {
  const {
    projectId,
    batchId,
    questionId,
    language,
    engine,
    history,
    revision,
  } = props;
  const [detail, setDetail] = useState<QuestionDetail | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setError('');
    const params = new URLSearchParams({
      project: projectId,
      batch: batchId,
      question: questionId,
      language,
      engine,
      history: history ? '1' : '0',
    });
    void fetch(`/api/geo/research?${params}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || '暂时无法读取平台结果');
        const result = body.detail as QuestionDetail;
        if (
          result?.version !== 1 ||
          result.projectId !== projectId ||
          result.batchId !== batchId ||
          result.questionId !== questionId ||
          result.language !== language
        )
          throw new Error('记录范围已变化，请重新打开详情。');
        if (!controller.signal.aborted) setDetail(result);
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : '读取失败');
      });
    return () => controller.abort();
  }, [projectId, batchId, questionId, language, engine, history, revision]);

  if (error)
    return (
      <p className="qd-loading" role="alert">
        {error}
      </p>
    );
  if (!detail)
    return (
      <div className="qd-loading" role="status">
        <span className="qd-loading-bar" />
        正在读取平台结果…
      </div>
    );
  const platforms = detail.platforms.filter((platform) =>
    props.recordKeys.includes(platform.recordKey),
  );
  return (
    <section className="qd-visual" aria-label="选择平台记录">
      <div className="qd-platform-grid">
        {platforms.map((platform) => {
          const selected = platform.recordKey === props.selectedKey;
          const known = platform.totalSources !== null && platform.officialCount !== null;
          const sourceLabel = platform.engine === 'google' || platform.engine === 'deepseek'
            ? '官方网页' : '官方来源';
          const state =
            platform.status === 'found'
              ? 'found'
              : platform.status === 'unmeasured'
                ? 'unknown'
                : 'missing';
          return (
            <article
              className={`qd-platform ${state}${selected ? ' selected' : ''}`}
              key={platform.recordKey}
            >
              <button
                className="qd-platform-select"
                aria-pressed={selected}
                aria-label={`查看 ${platform.label} ${platform.recordedAt?.slice(0, 10) || '未测'} 记录`}
                onClick={() => props.onSelect(platform.recordKey)}
              >
                <div className="qd-platform-head">
                  <span className={`rw-engine-icon ${platform.engine}`}>
                    {platform.label[0]}
                  </span>
                  <strong>{platform.label}</strong>
                  <time title={platform.recordedAt || undefined}>{platform.recordedAt?.slice(5, 10) || '未测'}</time>
                </div>
                <div className="qd-platform-meta">
                <span className={`qd-result ${state}`}>
                  {state === 'found' ? (
                    <CheckCircle2 size={16} />
                  ) : state === 'unknown' ? (
                    <CircleDashed size={16} />
                  ) : (
                    <CircleMinus size={16} />
                  )}
                  <span>
                    {known ? sourceLabel : state === 'unknown' ? '暂无有效结果' : '待核实'}
                  </span>
                  {known && (
                    <span className="qd-count" aria-label={`${sourceLabel} ${platform.officialCount}，共 ${platform.totalSources} 个来源`}>
                      <strong>{platform.officialCount}</strong><span>/ {platform.totalSources}</span>
                    </span>
                  )}
                  </span>
                  <span className="qd-platform-entry" title={platform.otherSourcesCount ? `另有 ${platform.otherSourcesCount} 个附带来源` : undefined}>{platform.entryLabel}</span>
                </div>
              </button>
            </article>
          );
        })}
      </div>
      <CompetitorCandidates
        key={`${projectId}:${batchId}:${questionId}`}
        projectId={projectId}
        batchId={batchId}
        questionId={questionId}
        revision={revision}
        language={language}
        engine={engine}
        compact
      />
    </section>
  );
}

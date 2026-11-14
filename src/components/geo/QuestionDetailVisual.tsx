'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, CircleDashed, CircleMinus } from 'lucide-react';
import type { QuestionDetail } from '@/lib/geo/question-detail-types';
import type { ResearchEngine } from '@/lib/geo/research-types';
import CompetitorCandidates from './CompetitorCandidates';
import { useUiLanguage } from './UiLanguageContext';

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
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const requestKey = `${projectId}:${batchId}:${questionId}:${language}:${engine}:${history ? '1' : '0'}:${revision}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    detail: QuestionDetail | null;
    error: string;
  }>({ key: '', detail: null, error: '' });
  const detail = loaded.key === requestKey ? loaded.detail : null;
  const error = loaded.key === requestKey ? loaded.error : '';
  useEffect(() => {
    const controller = new AbortController();
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
        if (!controller.signal.aborted) {
          setLoaded({ key: requestKey, detail: result, error: '' });
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setLoaded({
            key: requestKey,
            detail: null,
            error: reason instanceof Error ? reason.message : '读取失败',
          });
        }
      });
    return () => controller.abort();
  }, [projectId, batchId, questionId, language, engine, history, revision, requestKey]);

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
        {isEn ? 'Loading platform results…' : '正在读取平台结果…'}
      </div>
    );
  const platforms = detail.platforms.filter((platform) =>
    props.recordKeys.includes(platform.recordKey),
  );
  return (
    <section className="qd-visual" aria-label={isEn ? 'Select platform record' : '选择平台记录'}>
      <div className="qd-platform-grid">
        {platforms.map((platform) => {
          const selected = platform.recordKey === props.selectedKey;
          const known = platform.totalSources !== null && platform.officialCount !== null;
          const sourceLabel = platform.entryType === 'web_search' || platform.entryType === 'api_search' ||
            (!platform.entryType && (platform.engine === 'google' || platform.engine === 'deepseek'))
            ? (isEn ? 'Official page' : '官方网页')
            : (isEn ? 'Official source' : '官方来源');
          const hasMention = platform.mention !== undefined;
          const state = hasMention
            ? platform.mention === 'yes' || platform.status === 'found'
              ? 'found'
              : platform.mention === 'unknown' || platform.status === 'unmeasured'
                ? 'unknown'
                : 'missing'
            : platform.status === 'found'
              ? 'found'
              : platform.status === 'unmeasured'
                ? 'unknown'
                : 'missing';
          const mentionText =
            platform.mention === 'yes'
              ? (isEn ? 'Mentioned' : '回答已提及')
              : platform.mention === 'no'
                ? (isEn ? 'Not mentioned' : '回答未提及')
                : (isEn ? 'Pending' : '提及待核实');
          const entryDisplay = isEn
            ? ({
                '网页回答': 'Web Answer',
                'AI 概览': 'AI Overview',
                'AI 搜索': 'AI Search',
                '网页搜索': 'Web Search',
                '搜索 API': 'Search API',
              }[platform.entryLabel] ?? platform.entryLabel)
            : platform.entryLabel;
          return (
            <article
              className={`qd-platform ${state}${selected ? ' selected' : ''}`}
              key={platform.recordKey}
            >
              <button
                className="qd-platform-select"
                aria-pressed={selected}
                aria-label={
                  isEn
                    ? `View ${platform.label} ${platform.recordedAt?.slice(0, 10) || 'unmeasured'} record`
                    : `查看 ${platform.label} ${platform.recordedAt?.slice(0, 10) || '未测'} 记录`
                }
                onClick={() => props.onSelect(platform.recordKey)}
              >
                <div className="qd-platform-head">
                  <span className={`rw-engine-icon ${platform.engine}`}>
                    {platform.label[0]}
                  </span>
                  <strong>{platform.label}</strong>
                  <time title={platform.recordedAt || undefined}>
                    {platform.recordedAt?.slice(5, 10) || (isEn ? 'Not run' : '未测')}
                  </time>
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
                  {hasMention ? (
                    <>
                      <span>{mentionText}</span>
                      {known && (
                        <span
                          className="qd-count"
                          aria-label={
                            isEn
                              ? `Official links ${platform.officialCount} of ${platform.totalSources} sources`
                              : `官网链接 ${platform.officialCount}，共 ${platform.totalSources} 个来源`
                          }
                        >
                          <span className="qd-count-sep">
                            {isEn ? '· Official links' : '· 官网链接'}
                          </span>
                          <strong>{platform.officialCount}</strong>
                          <span>/ {platform.totalSources}</span>
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      <span>
                        {known
                          ? sourceLabel
                          : state === 'unknown'
                            ? (isEn ? 'Unavailable' : '暂无有效结果')
                            : (isEn ? 'Pending' : '待核实')}
                      </span>
                      {known && (
                        <span
                          className="qd-count"
                          aria-label={
                            isEn
                              ? `${sourceLabel} ${platform.officialCount} of ${platform.totalSources} sources`
                              : `${sourceLabel} ${platform.officialCount}，共 ${platform.totalSources} 个来源`
                          }
                        >
                          <strong>{platform.officialCount}</strong><span>/ {platform.totalSources}</span>
                        </span>
                      )}
                    </>
                  )}
                  </span>
                  <span
                    className="qd-platform-entry"
                    title={
                      platform.otherSourcesCount
                        ? isEn
                          ? `${platform.otherSourcesCount} additional sources`
                          : `另有 ${platform.otherSourcesCount} 个附带来源`
                        : undefined
                    }
                  >
                    {entryDisplay}
                  </span>
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

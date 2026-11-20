'use client';

import { useState } from 'react';
import { ArrowRight, ArrowUpRight, ChevronDown } from 'lucide-react';
import type {
  CompetitorCandidate,
  CompetitorCandidates,
  CompetitorComparison,
  CompetitorRow,
} from '@/lib/geo/competitor-types';
import { inferContentLang } from '@/lib/geo/i18n';
import type { ResearchEngine } from '@/lib/geo/research-types';
import { RESEARCH_ENGINE_NAMES } from '@/lib/geo/research-engines';
import { comparableCompetitorMention } from '@/lib/geo/competitor-presentation';
import {
  getCompetitorQuestionGaps,
  getCompetitorGapProgress,
  type CompetitorQuestionOpportunity,
} from '@/lib/geo/competitor-question-gaps';
import CompetitorPerformance from './CompetitorPerformance';
import { useUiLanguage } from './UiLanguageContext';
import './competitor-gap-journey.css';

type Props = {
  data: CompetitorCandidates;
  comparison?: CompetitorComparison;
  language: 'zh' | 'en';
  engine: ResearchEngine | 'all';
  onPreview: (candidate: CompetitorCandidate) => void;
};

const percent = (value: number) => `${Number(value.toFixed(1))}%`;
const change = (
  value: number,
  positive: string,
  negative: string,
  isEn: boolean,
) =>
  value === 0
    ? isEn
      ? 'Flat'
      : '持平'
    : isEn
      ? `${value > 0 ? positive : negative} ${Number(Math.abs(value).toFixed(1))} pp`
      : `${value > 0 ? positive : negative} ${Number(Math.abs(value).toFixed(1))} 个百分点`;

function answerExcerpt(excerpt: string, names: string[]) {
  const heading = excerpt.search(/\s#{1,6}\s/);
  if (heading < 0) return excerpt;
  const firstParagraph = excerpt.slice(0, heading).trim();
  return names.some((name) =>
    firstParagraph.toLocaleLowerCase().includes(name.toLocaleLowerCase()),
  )
    ? `${firstParagraph} …`
    : excerpt;
}

export default function CompetitorGapJourney({
  data,
  comparison,
  language,
  engine,
  onPreview,
}: Props) {
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const [focused, setFocused] = useState<{
    context: string;
    questionId: string;
  } | null>(null);
  const candidate = data.selectedCandidate;
  const target = data.target!;
  const ownName = comparison?.own.name || (isEn ? 'Us' : '我们');
  const candidateId = candidate?.id || data.selection?.candidateId;
  const context = `${data.projectId}:${data.batch?.id}:${candidateId || target.updatedAt}:${language}:${engine}`;
  const gaps = getCompetitorQuestionGaps(comparison, candidate, {
    language,
    engine,
  });
  const active =
    (focused?.context === context
      ? gaps.find((gap) => gap.questionId === focused.questionId)
      : null) || gaps[0];
  const performance = comparison?.performance || candidate?.performance;
  const measured = comparableCompetitorMention(performance, language, engine);
  const mention = measured?.metric;
  const tracked = getCompetitorGapProgress(
    comparison,
    data.selection || comparison?.selection,
    { language, engine },
  );
  const results = tracked.filter(
    ({ progress }) =>
      progress.ownChange !== null || progress.gapChange !== null,
  );
  const hasProgress = results.length > 0;

  function questionHref(row?: CompetitorRow) {
    return `/?${new URLSearchParams({
      view: 'question-plan',
      project: data.projectId,
      ...(data.batch ? { batch: data.batch.id } : {}),
      language: row?.language || language,
      engine: row?.engine || engine,
      ...(row
        ? {
            question: row.questionId,
            detail: 'answers',
            ...(data.batch
              ? {
                  record: `${data.batch.id}:${row.questionId}:${row.engine}:${row.language}:${row.observationIndex}`,
                }
              : {}),
          }
        : {}),
    })}`;
  }

  function improve(opportunity: CompetitorQuestionOpportunity) {
    const evidence = opportunity.evidence[0];
    if (!candidateId || !evidence) return;
    window.dispatchEvent(
      new CustomEvent('geo-competitor-improve', {
        detail: {
          projectId: data.projectId,
          batchId: evidence.batchId,
          questionId: evidence.questionId,
          language: evidence.language,
          engine: evidence.engine,
          candidateId,
        },
      }),
    );
  }

  return (
    <div className="cj-journey">
      <details className="cj-metrics">
        <summary>
          <span className="cj-context-label">
            {isEn ? 'Same-question mentions' : '同题提及'}
          </span>
          {mention && measured ? (
            <>
              <span>
                <span data-i18n-skip="">{ownName}</span>{' '}
                <strong>
                  {mention.own.yes}/{mention.own.completed}
                </strong>{' '}
                <small>({percent(mention.own.rate!)})</small>
              </span>
              <span>
                <span data-i18n-skip="">{target.name}</span>{' '}
                <strong>
                  {mention.target.yes}/{mention.target.completed}
                </strong>{' '}
                <small>({percent(mention.target.rate!)})</small>
              </span>
              <span className="cj-context-scope">
                {language === 'zh'
                  ? isEn
                    ? 'Chinese'
                    : '中文'
                  : isEn
                    ? 'English'
                    : '英文'}{' '}
                ·{' '}
                {measured.engine === 'all'
                  ? isEn
                    ? 'All platforms'
                    : '全部平台'
                  : RESEARCH_ENGINE_NAMES[measured.engine]}
              </span>
            </>
          ) : (
            <span>
              {isEn ? 'View saved measured data' : '查看已保存的实测数据'}
            </span>
          )}
          <span className="cj-metrics-open">
            {isEn ? 'All metrics' : '全部指标'} <ChevronDown size={12} />
          </span>
        </summary>
        {mention && mention.own.rate === mention.target.rate && (
          <p className="cj-metrics-note">
            {isEn
              ? 'Overall mention rates match, but the specific questions may differ. Inspect gaps per question below.'
              : '整体提及率相同，出现的问题可能不同。下面逐题查看差距。'}
          </p>
        )}
        <CompetitorPerformance
          performance={performance}
          ownName={ownName}
          targetName={target.name}
          language={language}
          engine={engine}
        />
      </details>

      {active ? (
        <div className={`cj-layout${gaps.length > 1 ? ' has-questions' : ''}`}>
          {gaps.length > 1 && (
            <nav
              className="cj-questions"
              aria-label={isEn ? 'Missed questions list' : '漏题列表'}
            >
              <h3>
                {isEn ? 'Missed questions' : '漏在哪道题'}{' '}
                <span>{gaps.length}</span>
              </h3>
              {gaps.map((gap, index) => (
                <button
                  key={gap.questionId}
                  type="button"
                  aria-current={
                    active.questionId === gap.questionId ? 'true' : undefined
                  }
                  onClick={() =>
                    setFocused({ context, questionId: gap.questionId })
                  }
                >
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <span>
                    <span lang={inferContentLang(gap.question)}>
                      {gap.question}
                    </span>
                    <small>
                      {gap.answers
                        .map(({ row }) => RESEARCH_ENGINE_NAMES[row.engine])
                        .join(' · ')}
                    </small>
                  </span>
                  <ArrowRight size={13} />
                </button>
              ))}
            </nav>
          )}
          <article
            className="cj-question"
            key={`${context}:${active.questionId}`}
            aria-label={
              isEn ? 'Current missed question & improvements' : '当前漏题与改进'
            }
          >
            <header className="cj-question-heading">
              <span className="cj-eyebrow">
                {isEn ? 'Missed question' : '漏在哪道题'}
              </span>
              <h3 lang={inferContentLang(active.question)}>
                {active.question}
              </h3>
              <p>
                {isEn ? (
                  <>
                    {[
                      ...new Set(
                        active.answers.map(
                          ({ row }) => RESEARCH_ENGINE_NAMES[row.engine],
                        ),
                      ),
                    ].join(', ')}{' '}
                    mentioned <strong data-i18n-skip="">{target.name}</strong>{' '}
                    but did not mention{' '}
                    <span data-i18n-skip="">{ownName}</span>.
                  </>
                ) : (
                  <>
                    {[
                      ...new Set(
                        active.answers.map(
                          ({ row }) => RESEARCH_ENGINE_NAMES[row.engine],
                        ),
                      ),
                    ].join('、')}{' '}
                    的回答提到了{' '}
                    <strong data-i18n-skip="">{target.name}</strong>，未提到{' '}
                    <span data-i18n-skip="">{ownName}</span>。
                  </>
                )}
              </p>
            </header>
            {active.answers.map(({ row, opportunities }) => (
              <div
                className="cj-answer"
                key={`${row.id}:${row.engine}:${row.observationIndex}`}
              >
                {active.answers.length > 1 && (
                  <p className="cj-platform">
                    {RESEARCH_ENGINE_NAMES[row.engine]} ·{' '}
                    {row.language === 'zh'
                      ? isEn
                        ? 'Chinese'
                        : '中文'
                      : isEn
                        ? 'English'
                        : '英文'}
                  </p>
                )}
                <section
                  className="cj-evidence"
                  aria-label={
                    isEn
                      ? `${RESEARCH_ENGINE_NAMES[row.engine]} answer evidence`
                      : `${RESEARCH_ENGINE_NAMES[row.engine]} 原回答依据`
                  }
                >
                  <div className="cj-section-heading">
                    <h4>{isEn ? 'Answer evidence' : '原回答依据'}</h4>
                    <a href={questionHref(row)} className="cx-text-button">
                      {isEn ? 'View full answer' : '查看完整回答'}{' '}
                      <ArrowUpRight size={13} />
                    </a>
                  </div>
                  <p className="cj-answer-meta">
                    {RESEARCH_ENGINE_NAMES[row.engine]} ·{' '}
                    {row.language === 'zh'
                      ? isEn
                        ? 'Chinese'
                        : '中文'
                      : isEn
                        ? 'English'
                        : '英文'}
                    {(row.collectedAt || row.recordedAt).match(
                      /^\d{4}-\d{2}-\d{2}/,
                    )?.[0] &&
                      (isEn
                        ? ` · Recorded ${(row.collectedAt || row.recordedAt).slice(0, 10)}`
                        : ` · 记录于 ${(row.collectedAt || row.recordedAt).slice(0, 10)}`)}
                  </p>
                  {row.targetMention.excerpts.length ? (
                    [...new Set(row.targetMention.excerpts)]
                      .slice(0, 2)
                      .map((excerpt, index) => (
                        <blockquote
                          key={index}
                          lang={row.language || inferContentLang(excerpt)}
                        >
                          {answerExcerpt(excerpt, row.targetMention.names)}
                        </blockquote>
                      ))
                  ) : (
                    <p className="cj-note">
                      {isEn ? (
                        <>
                          Open the full answer to see the context where{' '}
                          <span data-i18n-skip="">{target.name}</span> was
                          mentioned.
                        </>
                      ) : (
                        <>
                          打开完整回答，查看{' '}
                          <span data-i18n-skip="">{target.name}</span>{' '}
                          被提及时的上下文。
                        </>
                      )}
                    </p>
                  )}
                  {row.sources.some((source) => source.target) && (
                    <div className="cj-sources">
                      <span>{isEn ? 'Related sources' : '相关来源'}</span>
                      {row.sources
                        .filter((source) => source.target)
                        .slice(0, 3)
                        .map((source) => (
                          <a
                            key={source.url}
                            href={source.url}
                            target="_blank"
                            rel="noreferrer"
                            data-i18n-skip=""
                          >
                            {source.title || source.url}{' '}
                            <ArrowUpRight size={11} />
                          </a>
                        ))}
                    </div>
                  )}
                </section>
                <section
                  className="cj-actions"
                  aria-label={
                    isEn
                      ? `${RESEARCH_ENGINE_NAMES[row.engine]} recommended actions`
                      : `${RESEARCH_ENGINE_NAMES[row.engine]} 具体改进`
                  }
                >
                  <div className="cj-section-heading">
                    <h4>{isEn ? 'What to change' : '具体改什么'}</h4>
                    {opportunities.length > 0 && (
                      <span>{isEn ? 'AI suggestion' : 'AI 建议'}</span>
                    )}
                  </div>
                  {opportunities.length ? (
                    opportunities.map((opportunity, index) => (
                      <div className="cj-action-item" key={index}>
                        <p
                          className="cj-action-text"
                          lang={inferContentLang(opportunity.action)}
                        >
                          {opportunity.action}
                        </p>
                        <details className="cj-action-reason">
                          <summary>
                            {isEn ? 'Supporting evidence' : '建议依据'}{' '}
                            <ChevronDown size={12} />
                          </summary>
                          <p lang={inferContentLang(opportunity.observed)}>
                            {opportunity.observed}
                          </p>
                          {opportunity.hypothesis && (
                            <p>
                              {isEn ? 'Hypothesis: ' : '原因假设：'}
                              <span
                                lang={inferContentLang(opportunity.hypothesis)}
                              >
                                {opportunity.hypothesis}
                              </span>
                            </p>
                          )}
                        </details>
                        <div className="cj-action-footer">
                          <p>
                            {isEn
                              ? `After publishing, retest this question on ${RESEARCH_ENGINE_NAMES[row.engine]} under the same conditions.`
                              : `完成改进后，用这道题在 ${RESEARCH_ENGINE_NAMES[row.engine]} 同条件复测。`}
                          </p>
                          <button
                            type="button"
                            className="cc-button primary"
                            disabled={!candidateId}
                            onClick={() => improve(opportunity)}
                          >
                            {isEn ? 'Plan improvement' : '制定改进方案'}{' '}
                            <ArrowRight size={14} />
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="cj-no-action">
                      <p>
                        {isEn
                          ? 'Inspect what capabilities this answer highlights, then decide what to add.'
                          : '先看这条回答推荐了哪些能力，再确定要补充的内容。'}
                      </p>
                      <a href={questionHref(row)} className="cx-text-button">
                        {isEn ? 'Analyze on Questions page' : '到问题页分析'}{' '}
                        <ArrowRight size={13} />
                      </a>
                    </div>
                  )}
                </section>
              </div>
            ))}
          </article>
        </div>
      ) : (
        <section className="cj-no-gaps">
          <h3>
            {isEn ? 'No confirmed missed questions yet' : '当前没有已确认的漏题'}
          </h3>
          <p>
            {isEn ? (
              <>
                Review answers to the same questions to see how{' '}
                <span data-i18n-skip="">{target.name}</span> is described.
              </>
            ) : (
              <>
                查看同题回答，了解 <span data-i18n-skip="">{target.name}</span>{' '}
                被怎样介绍。
              </>
            )}
          </p>
          <a href={questionHref()} className="cx-text-button">
            {isEn ? 'View questions & answers' : '查看问题与回答'}{' '}
            <ArrowRight size={13} />
          </a>
        </section>
      )}

      <section
        className={`cj-followup${hasProgress ? ' has-results' : ''}`}
        aria-label={isEn ? 'Retest results' : '复测结果'}
      >
        <div className="cj-section-heading">
          <h3>{isEn ? 'Retest results' : '复测结果'}</h3>
        </div>
        {hasProgress ? (
          results.map(({ questionId, question, progress }) => (
            <article className="cj-followup-question" key={questionId}>
              <h4 lang={inferContentLang(question)}>{question}</h4>
              <dl>
                {progress.ownChange !== null && (
                  <div>
                    <dt>{isEn ? 'Our performance' : '自身表现'}</dt>
                    <dd>
                      {change(
                        progress.ownChange,
                        isEn ? 'Up' : '提升',
                        isEn ? 'Down' : '下降',
                        isEn,
                      )}
                    </dd>
                  </div>
                )}
                {progress.gapChange !== null && (
                  <div>
                    <dt>
                      {isEn ? (
                        <>
                          Gap vs <span data-i18n-skip="">{target.name}</span>
                        </>
                      ) : (
                        <>
                          与 <span data-i18n-skip="">{target.name}</span> 的差距
                        </>
                      )}
                    </dt>
                    <dd>
                      {change(
                        progress.gapChange,
                        isEn ? 'Narrowed' : '缩小',
                        isEn ? 'Widened' : '扩大',
                        isEn,
                      )}
                    </dd>
                  </div>
                )}
              </dl>
            </article>
          ))
        ) : (
          <p>
            {isEn
              ? 'No comparable retest results yet. After publishing improvements, check how your mention rate and gap changed.'
              : '尚无可比复测结果。完成改进后，查看自身表现和与参照的差距变化。'}
          </p>
        )}
        {tracked.length > 0 && (
          <details className="cj-followup-details">
            <summary>
              {isEn ? 'Retest conditions' : '复测条件'}{' '}
              <ChevronDown size={12} />
            </summary>
            {tracked.map(({ questionId, question, progress }) => (
              <p key={questionId}>
                {tracked.length > 1 && (
                  <span lang={inferContentLang(question)}>
                    {question}
                    {isEn ? ': ' : '：'}
                  </span>
                )}
                <span lang={inferContentLang(progress.reason)}>
                  {progress.reason}
                </span>
              </p>
            ))}
          </details>
        )}
      </section>
      {candidate && (
        <div className="cj-all-evidence">
          <button
            type="button"
            className="cx-text-button"
            onClick={() => onPreview(candidate)}
          >
            {isEn ? 'View all comparison evidence' : '查看全部对照依据'}{' '}
            <ArrowUpRight size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

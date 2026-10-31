'use client';

import { useState } from 'react';
import { ArrowRight, ArrowUpRight, ChevronDown } from 'lucide-react';
import type {
  CompetitorCandidate,
  CompetitorCandidates,
  CompetitorComparison,
  CompetitorRow,
} from '@/lib/geo/competitor-types';
import type { ResearchEngine } from '@/lib/geo/research-types';
import { RESEARCH_ENGINE_NAMES } from '@/lib/geo/research-engines';
import { comparableCompetitorMention } from '@/lib/geo/competitor-presentation';
import {
  getCompetitorQuestionGaps,
  getCompetitorGapProgress,
  type CompetitorQuestionOpportunity,
} from '@/lib/geo/competitor-question-gaps';
import CompetitorPerformance from './CompetitorPerformance';
import './competitor-gap-journey.css';

type Props = {
  data: CompetitorCandidates;
  comparison?: CompetitorComparison;
  language: 'zh' | 'en';
  engine: ResearchEngine | 'all';
  onPreview: (candidate: CompetitorCandidate) => void;
};

const percent = (value: number) => `${Number(value.toFixed(1))}%`;
const change = (value: number, positive: string, negative: string) =>
  value === 0
    ? '持平'
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
  const [focused, setFocused] = useState<{
    context: string;
    questionId: string;
  } | null>(null);
  const candidate = data.selectedCandidate;
  const target = data.target!;
  const ownName = comparison?.own.name || '我们';
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
      view: 'questions',
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
          <span className="cj-context-label">同题提及</span>
          {mention && measured ? (
            <>
              <span>
                {ownName}{' '}
                <strong>
                  {mention.own.yes}/{mention.own.completed}
                </strong>{' '}
                <small>（{percent(mention.own.rate!)}）</small>
              </span>
              <span>
                {target.name}{' '}
                <strong>
                  {mention.target.yes}/{mention.target.completed}
                </strong>{' '}
                <small>（{percent(mention.target.rate!)}）</small>
              </span>
              <span className="cj-context-scope">
                {language === 'zh' ? '中文' : '英文'} ·{' '}
                {measured.engine === 'all'
                  ? '全部平台'
                  : RESEARCH_ENGINE_NAMES[measured.engine]}
              </span>
            </>
          ) : (
            <span>查看已保存的实测数据</span>
          )}
          <span className="cj-metrics-open">
            全部指标 <ChevronDown size={12} />
          </span>
        </summary>
        {mention && mention.own.rate === mention.target.rate && (
          <p className="cj-metrics-note">
            整体提及率相同，出现的问题可能不同。下面逐题查看差距。
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
            <nav className="cj-questions" aria-label="漏题列表">
              <h3>
                漏在哪道题 <span>{gaps.length}</span>
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
                    {gap.question}
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
            aria-label="当前漏题与改进"
          >
            <header className="cj-question-heading">
              <span className="cj-eyebrow">漏在哪道题</span>
              <h3>{active.question}</h3>
              <p>
                {[
                  ...new Set(
                    active.answers.map(
                      ({ row }) => RESEARCH_ENGINE_NAMES[row.engine],
                    ),
                  ),
                ].join('、')}{' '}
                的回答提到了 <strong>{target.name}</strong>，未提到 {ownName}。
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
                    {row.language === 'zh' ? '中文' : '英文'}
                  </p>
                )}
                <section
                  className="cj-evidence"
                  aria-label={`${RESEARCH_ENGINE_NAMES[row.engine]} 原回答依据`}
                >
                  <div className="cj-section-heading">
                    <h4>原回答依据</h4>
                    <a href={questionHref(row)} className="cx-text-button">
                      查看完整回答 <ArrowUpRight size={13} />
                    </a>
                  </div>
                  <p className="cj-answer-meta">
                    {RESEARCH_ENGINE_NAMES[row.engine]} ·{' '}
                    {row.language === 'zh' ? '中文' : '英文'}
                    {(row.collectedAt || row.recordedAt).match(
                      /^\d{4}-\d{2}-\d{2}/,
                    )?.[0] &&
                      ` · 记录于 ${(row.collectedAt || row.recordedAt).slice(0, 10)}`}
                  </p>
                  {row.targetMention.excerpts.length ? (
                    [...new Set(row.targetMention.excerpts)]
                      .slice(0, 2)
                      .map((excerpt, index) => (
                        <blockquote key={index}>
                          {answerExcerpt(excerpt, row.targetMention.names)}
                        </blockquote>
                      ))
                  ) : (
                    <p className="cj-note">
                      打开完整回答，查看 {target.name} 被提及时的上下文。
                    </p>
                  )}
                  {row.sources.some((source) => source.target) && (
                    <div className="cj-sources">
                      <span>相关来源</span>
                      {row.sources
                        .filter((source) => source.target)
                        .slice(0, 3)
                        .map((source) => (
                          <a
                            key={source.url}
                            href={source.url}
                            target="_blank"
                            rel="noreferrer"
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
                  aria-label={`${RESEARCH_ENGINE_NAMES[row.engine]} 具体改进`}
                >
                  <div className="cj-section-heading">
                    <h4>具体改什么</h4>
                    {opportunities.length > 0 && <span>AI 建议</span>}
                  </div>
                  {opportunities.length ? (
                    opportunities.map((opportunity, index) => (
                      <div className="cj-action-item" key={index}>
                        <p className="cj-action-text">{opportunity.action}</p>
                        <details className="cj-action-reason">
                          <summary>
                            建议依据 <ChevronDown size={12} />
                          </summary>
                          <p>{opportunity.observed}</p>
                          {opportunity.hypothesis && (
                            <p>原因假设：{opportunity.hypothesis}</p>
                          )}
                        </details>
                        <div className="cj-action-footer">
                          <p>
                            完成改进后，用这道题在{' '}
                            {RESEARCH_ENGINE_NAMES[row.engine]} 同条件复测。
                          </p>
                          <button
                            type="button"
                            className="cc-button primary"
                            disabled={!candidateId}
                            onClick={() => improve(opportunity)}
                          >
                            制定改进方案 <ArrowRight size={14} />
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="cj-no-action">
                      <p>先看这条回答推荐了哪些能力，再确定要补充的内容。</p>
                      <a href={questionHref(row)} className="cx-text-button">
                        到问题页分析 <ArrowRight size={13} />
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
          <h3>当前没有已确认的漏题</h3>
          <p>查看同题回答，了解 {target.name} 被怎样介绍。</p>
          <a href={questionHref()} className="cx-text-button">
            查看问题与回答 <ArrowRight size={13} />
          </a>
        </section>
      )}

      <section
        className={`cj-followup${hasProgress ? ' has-results' : ''}`}
        aria-label="复测结果"
      >
        <div className="cj-section-heading">
          <h3>复测结果</h3>
        </div>
        {hasProgress ? (
          results.map(({ questionId, question, progress }) => (
            <article className="cj-followup-question" key={questionId}>
              <h4>{question}</h4>
              <dl>
                {progress.ownChange !== null && (
                  <div>
                    <dt>自身表现</dt>
                    <dd>{change(progress.ownChange, '提升', '下降')}</dd>
                  </div>
                )}
                {progress.gapChange !== null && (
                  <div>
                    <dt>与 {target.name} 的差距</dt>
                    <dd>{change(progress.gapChange, '缩小', '扩大')}</dd>
                  </div>
                )}
              </dl>
            </article>
          ))
        ) : (
          <p>尚无可比复测结果。完成改进后，查看自身表现和与参照的差距变化。</p>
        )}
        {tracked.length > 0 && (
          <details className="cj-followup-details">
            <summary>
              复测条件 <ChevronDown size={12} />
            </summary>
            {tracked.map(({ questionId, question, progress }) => (
              <p key={questionId}>
                {tracked.length > 1 && `${question}：`}
                {progress.reason}
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
            查看全部对照依据 <ArrowUpRight size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

'use client';

import { useState } from 'react';
import { ArrowRight, ArrowUpRight, ChevronDown, FileText } from 'lucide-react';
import { inferContentLang, plural } from '@/lib/geo/i18n';
import type { GeoAsset, GeoQuestion, GeoState } from '@/lib/geo/types';
import type {
  GeoProviderId,
  GeoVisibility,
  GeoVisibilityQuestion,
  GeoVisibilityResult,
} from '@/lib/geo/visibility-types';
import GeoSelect from './GeoSelect';
import { getTaskWorkspaceGroups } from './TaskWorkspace';
import { useUiLanguage } from './UiLanguageContext';
import './overview-pages.css';

type ProviderFilter = 'all' | GeoProviderId;
type Props = {
  data: GeoState;
  onAsset: (asset: GeoAsset) => void;
  onTask: () => void;
  onQuestions: () => void;
  onEvidence: (path: string) => void;
};

function dateLabel(value: string | null, isEn: boolean) {
  if (!value) return isEn ? 'Unmeasured' : '未测';
  return new Date(value).toLocaleDateString(isEn ? 'en-US' : 'zh-CN', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}
function resultLabel(
  result: GeoVisibilityResult,
  uiLanguage: 'zh' | 'en',
  isEn: boolean,
) {
  if (result.status === 'unmeasured') return isEn ? 'Unmeasured' : '未测';
  if (result.status === 'not_found')
    return result.metric === 'answer_target_citation'
      ? isEn
        ? 'Target not cited'
        : '未引用目标'
      : isEn
        ? 'Project not found'
        : '未找到项目';
  const ranked = result.sources.find(
    (source) => source.attribution === 'web_result' && source.position !== null,
  );
  if (ranked)
    return isEn ? `Web #${ranked.position}` : `网页第 ${ranked.position} 条`;
  const citations = result.sources.filter(
    (source) => source.attribution === 'citation',
  );
  if (citations.length)
    return isEn
      ? plural(uiLanguage, citations.length, {
          one: `${citations.length} page cited`,
          other: `${citations.length} pages cited`,
        })
      : `引用 ${citations.length} 页`;
  return result.sources.length
    ? isEn
      ? plural(uiLanguage, result.sources.length, {
          one: `${result.sources.length} link listed`,
          other: `${result.sources.length} links listed`,
        })
      : `列出 ${result.sources.length} 个链接`
    : isEn
      ? 'Found'
      : '已找到';
}
function domainLabel(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
function savedQuestion(
  data: GeoState,
  result: GeoVisibilityResult,
): GeoQuestion | undefined {
  if (!result.evidencePath) return undefined;
  const records = [
    ...data.questions,
    ...data.tasks.flatMap((task) => [
      ...task.runs.flatMap((run) => run.questions),
      ...(task.workflow?.baseline?.questions ?? []),
      ...(task.workflowHistory ?? []).flatMap(
        (workflow) => workflow.baseline?.questions ?? [],
      ),
    ]),
  ];
  const matches = records.filter(
    (question) =>
      question.evidencePath === result.evidencePath &&
      question.query === result.query,
  );
  return matches.find((question) => question.answer?.text.trim()) ?? matches[0];
}

function ProviderRecord({
  result,
  provider,
  data,
  onAsset,
  onEvidence,
}: {
  result: GeoVisibilityResult;
  provider: GeoVisibility['providers'][number];
  data: GeoState;
  onAsset: Props['onAsset'];
  onEvidence: Props['onEvidence'];
}) {
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const saved = savedQuestion(data, result);
  const answer = saved?.answer;
  const excerpt = answer?.text.trim();
  const extraSources = (answer?.citations ?? saved?.topSources ?? []).filter(
    (source, index, sources) =>
      !result.sources.some((target) => target.url === source.url) &&
      sources.findIndex((other) => other.url === source.url) === index,
  );
  return (
    <article className="ov-platform-card">
      <header className="ov-platform-heading">
        <span className={`ov-platform-mark ${provider.id}`} aria-hidden="true">
          {provider.label.slice(0, 1)}
        </span>
        <h3>{provider.label}</h3>
        <span className={`ov-record-status ${result.status}`}>
          {resultLabel(result, uiLanguage, isEn)}
        </span>
      </header>
      <p className="ov-record-meta">
        {provider.kind === 'answer'
          ? isEn
            ? 'AI answer'
            : 'AI 回答'
          : isEn
            ? 'Web search'
            : '网页搜索'}
        {result.mode ? ` · ${result.mode}` : ''} ·{' '}
        {dateLabel(result.recordedAt, isEn)}
      </p>
      <p
        className="ov-record-summary"
        lang={result.summary ? inferContentLang(result.summary) : undefined}
      >
        {result.summary}
      </p>
      {excerpt && (
        <p className="ov-answer-excerpt" lang={inferContentLang(excerpt)}>
          {excerpt.length > 240 ? `${excerpt.slice(0, 240)}…` : excerpt}
        </p>
      )}
      {result.sources.length > 0 && (
        <div className="ov-source-links">
          {result.sources.map((source, sourceIndex) => {
            const asset = data.assets.find(
              (item) => item.id === source.assetId,
            );
            return (
              <div key={`${source.url}-${source.attribution}-${sourceIndex}`}>
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  data-i18n-skip=""
                >
                  {source.title} <ArrowUpRight size={14} />
                </a>
                <small>
                  <span data-i18n-skip="">{domainLabel(source.url)}</span> ·{' '}
                  {source.attribution === 'citation'
                    ? isEn
                      ? 'Cited in answer'
                      : '回答引用'
                    : source.attribution === 'web_result'
                      ? isEn
                        ? `Web result${source.position ? ` #${source.position}` : ''}`
                        : `网页结果${source.position ? `第 ${source.position} 条` : ''}`
                      : isEn
                        ? 'Link in answer'
                        : '回答中的链接'}
                </small>
                {asset && (
                  <button
                    type="button"
                    className="ov-source-read"
                    onClick={() => onAsset(asset)}
                  >
                    {isEn ? 'Read existing page' : '阅读已有正文'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {extraSources.length > 0 && (
        <div className="ov-other-sources">
          <span>
            {answer
              ? isEn
                ? 'Also cited in answer'
                : '回答还引用了'
              : isEn
                ? 'Other search results'
                : '搜索返回的其他页面'}
          </span>
          {extraSources.slice(0, 3).map((source) => (
            <a
              key={source.url}
              href={source.url}
              target="_blank"
              rel="noreferrer"
              data-i18n-skip=""
            >
              {source.title || domainLabel(source.url)}{' '}
              <ArrowUpRight size={13} />
            </a>
          ))}
        </div>
      )}
      <details className="ov-record-details">
        <summary>
          {isEn ? 'Original query & evidence' : '原始问法与证据'}{' '}
          <ChevronDown size={14} />
        </summary>
        <div>
          {result.query && (
            <p className="ov-exact-query" lang={inferContentLang(result.query)}>
              {result.query}
            </p>
          )}
          {result.caveat && (
            <p lang={inferContentLang(result.caveat)}>{result.caveat}</p>
          )}
          {result.sampleCount > 0 && (
            <p>
              {isEn
                ? plural(uiLanguage, result.sampleCount, {
                    one: `${result.sampleCount} completed measurement`,
                    other: `${result.sampleCount} completed measurements`,
                  })
                : `${result.sampleCount} 次已完成测量`}
            </p>
          )}
          {result.evidencePath && (
            <button
              type="button"
              className="og-text-button"
              onClick={() => onEvidence(result.evidencePath!)}
            >
              {isEn ? 'View raw evidence' : '查看原始证据'}{' '}
              <ArrowRight size={13} />
            </button>
          )}
        </div>
      </details>
      {excerpt && (
        <details className="ov-record-details">
          <summary>
            {isEn ? 'Full answer' : '完整回答'} <ChevronDown size={14} />
          </summary>
          <div className="ov-full-answer" lang={inferContentLang(excerpt)}>
            {excerpt}
          </div>
        </details>
      )}
    </article>
  );
}

function QuestionResults({
  question,
  visibility,
  filter,
  data,
  onAsset,
  onEvidence,
}: {
  question: GeoVisibilityQuestion;
  visibility: GeoVisibility;
  filter: ProviderFilter;
  data: GeoState;
  onAsset: Props['onAsset'];
  onEvidence: Props['onEvidence'];
}) {
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const providers = visibility.providers.filter(
    (provider) => filter === 'all' || provider.id === filter,
  );
  const measured = providers.flatMap((provider) =>
    question.results
      .filter(
        (result) =>
          result.providerId === provider.id && result.status !== 'unmeasured',
      )
      .map((result) => ({ provider, result })),
  );
  const unmeasured = providers.filter(
    (provider) =>
      !question.results.some(
        (result) =>
          result.providerId === provider.id && result.status !== 'unmeasured',
      ),
  );
  const related = data.assets.filter((asset) =>
    question.relatedAssetIds.includes(asset.id),
  );
  return (
    <>
      {measured.length > 0 ? (
        <div className="ov-platform-grid">
          {measured.map(({ provider, result }, index) => (
            <ProviderRecord
              key={`${provider.id}-${result.recordedAt}-${index}`}
              provider={provider}
              result={result}
              data={data}
              onAsset={onAsset}
              onEvidence={onEvidence}
            />
          ))}
        </div>
      ) : (
        <p className="ov-empty-record">
          {isEn
            ? 'No readable measurement records for this question yet.'
            : '这个问题还没有可读取的测量记录。'}
        </p>
      )}
      {unmeasured.length > 0 && (
        <p className="ov-unmeasured">
          {unmeasured
            .map((provider) => {
              const result = question.results.find(
                (entry) => entry.providerId === provider.id,
              );
              const unreadable = result?.summary.includes('无法读取');
              return isEn
                ? `${provider.label}: ${unreadable ? 'Unreadable record' : 'Unmeasured'}`
                : `${provider.label}：${unreadable ? '记录不可读取' : '未测'}`;
            })
            .join(' · ')}
        </p>
      )}
      {related.length > 0 && (
        <details className="ov-related">
          <summary>
            {isEn ? 'Related existing content' : '相关已有内容'}{' '}
            <ChevronDown size={14} />
          </summary>
          <div>
            {related.map((asset) => (
              <button
                key={asset.id}
                type="button"
                onClick={() => onAsset(asset)}
              >
                <FileText size={14} />
                <span data-i18n-skip="">{asset.title}</span>
                <ArrowUpRight size={13} />
              </button>
            ))}
          </div>
        </details>
      )}
    </>
  );
}

export default function VisibilityPanel({
  data,
  onAsset,
  onTask,
  onQuestions,
  onEvidence,
}: Props) {
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const [filter, setFilter] = useState<ProviderFilter>('all');
  const visibility = data.visibility;
  const selected = data.questionPlan.candidates.filter(
    (candidate) =>
      candidate.selected && candidate.review.decision !== 'exclude',
  );
  const suggested = selected.length
    ? selected
    : data.questionPlan.candidates.filter(
        (candidate) => candidate.review.decision === 'include',
      );
  const ready = data.questionPlan.status === 'ready';
  const representativeQuestions = suggested.filter(
    (candidate, index) =>
      suggested.findIndex((other) => other.category === candidate.category) ===
      index,
  );
  const shownQuestions = [
    ...representativeQuestions,
    ...suggested.filter(
      (candidate) => !representativeQuestions.includes(candidate),
    ),
  ].slice(0, 3);
  const featured =
    visibility?.questions.find((question) => question.kind === 'brand') ??
    visibility?.questions[0];
  const otherQuestions =
    visibility?.questions.filter((question) => question !== featured) ?? [];
  const groups = getTaskWorkspaceGroups(data.tasks);

  return (
    <div className="ov-page">
      <header className="og-page-heading">
        <div>
          <h1>{isEn ? 'Overview' : '项目概览'}</h1>
        </div>
      </header>
      <section className="ov-next-action">
        <div>
          {data.questionPlan.candidates.length > 0 && (
            <span className="ov-action-state">
              {ready
                ? isEn
                  ? 'Questions confirmed'
                  : '题单已确认'
                : isEn
                  ? 'Needs review'
                  : '待你确认'}
            </span>
          )}
          <h2>
            {ready
              ? isEn
                ? plural(uiLanguage, selected.length, {
                    one: `${selected.length} question selected`,
                    other: `${selected.length} questions selected`,
                  })
                : `已选好 ${selected.length} 个问题`
              : data.questionPlan.candidates.length
                ? isEn
                  ? 'Confirm questions to check'
                  : '确认要搜索的问题'
                : isEn
                  ? 'Prepare buyer questions'
                  : '整理值得搜索的问题'}
          </h2>
          <p>
            {ready ? (
              isEn ? (
                'Review your selected questions and pick how to run this check.'
              ) : (
                '查看已选问题，再选择本轮搜索方式。'
              )
            ) : isEn ? (
              <>
                How would buyers ask AI to find{' '}
                <span data-i18n-skip="">{data.project.name}</span>?
              </>
            ) : (
              <>
                用户会怎样提问，才能找到{' '}
                <span data-i18n-skip="">{data.project.name}</span>？
              </>
            )}
          </p>
          <div className="ov-next-actions">
            <button
              type="button"
              className="og-button primary"
              onClick={onQuestions}
            >
              {ready
                ? isEn
                  ? 'View selected questions'
                  : '查看已选问题'
                : suggested.length
                  ? isEn
                    ? plural(uiLanguage, suggested.length, {
                        one: `Review ${suggested.length} ${selected.length ? 'selected' : 'candidate'} question`,
                        other: `Review ${suggested.length} ${selected.length ? 'selected' : 'candidate'} questions`,
                      })
                    : `审阅 ${suggested.length} 个${selected.length ? '已选' : '候选'}问题`
                  : isEn
                    ? 'Build question list'
                    : '整理搜索题单'}{' '}
              <ArrowRight size={15} />
            </button>
            {ready && (
              <button type="button" className="og-text-button" onClick={onTask}>
                {groups.tasks.length
                  ? isEn
                    ? 'Continue current tasks'
                    : '继续现有任务'
                  : isEn
                    ? 'Create search task'
                    : '创建搜索任务'}{' '}
                <ArrowRight size={14} />
              </button>
            )}
          </div>
        </div>
        {suggested.length > 0 ? (
          <ol className="ov-next-questions">
            {shownQuestions.map((candidate) => (
              <li
                key={candidate.id}
                lang={inferContentLang(candidate.query)}
              >
                {candidate.query}
              </li>
            ))}
            {suggested.length > 3 && (
              <li className="ov-next-more">
                <button type="button" onClick={onQuestions}>
                  {isEn
                    ? plural(uiLanguage, suggested.length - 3, {
                        one: `${suggested.length - 3} more question`,
                        other: `${suggested.length - 3} more questions`,
                      })
                    : `另有 ${suggested.length - 3} 个问题`}{' '}
                  <ArrowRight size={13} />
                </button>
              </li>
            )}
          </ol>
        ) : null}
      </section>
      {featured && visibility ? (
        <section className="ov-platform-section">
          <header className="ov-section-heading">
            <div>
              <h2>{isEn ? 'Platform answers & sources' : '平台回答与来源'}</h2>
              <p lang={inferContentLang(featured.title)}>{featured.title}</p>
            </div>
            <div className="ov-provider-filter">
              <span>{isEn ? 'Platform' : '搜索入口'}</span>
              <GeoSelect<ProviderFilter>
                label={isEn ? 'Filter by platform' : '筛选搜索入口'}
                value={filter}
                onChange={setFilter}
                options={[
                  {
                    value: 'all',
                    label: isEn ? 'All platforms' : '全部入口',
                  },
                  ...visibility.providers.map((provider) => ({
                    value: provider.id,
                    label: provider.label,
                  })),
                ]}
              />
            </div>
          </header>
          <QuestionResults
            question={featured}
            visibility={visibility}
            filter={filter}
            data={data}
            onAsset={onAsset}
            onEvidence={onEvidence}
          />
          {featured.kind === 'brand' && (
            <p className="ov-scope-note">
              {isEn
                ? 'Branded-query results do not mean buyers find you without naming your product. Platforms, queries, and dates are tracked separately.'
                : '品牌提问下的记录，不能代表不提项目名时也能被找到。各入口、问法与测量日期分别保留。'}
            </p>
          )}
        </section>
      ) : (
        <section className="ov-empty">
          <h2>{isEn ? 'No platform answers yet' : '尚无平台回答'}</h2>
          <p>
            {isEn
              ? 'Confirm your questions and collect answers to see saved responses and sources here.'
              : '确认题单并完成搜索后，这里会显示已保存的回答和来源。'}
          </p>
        </section>
      )}
      {otherQuestions.length > 0 && visibility && (
        <section className="ov-saved-records">
          <header className="ov-section-heading">
            <h2>{isEn ? 'Other question records' : '其他问题的记录'}</h2>
            <span>
              {isEn
                ? plural(uiLanguage, otherQuestions.length, {
                    one: `${otherQuestions.length} query`,
                    other: `${otherQuestions.length} queries`,
                  })
                : `${otherQuestions.length} 条问法`}
            </span>
          </header>
          <div className="ov-question-list">
            {otherQuestions.map((question) => (
              <details
                className="ov-question-record"
                key={question.id}
                open={question.results.some(
                  (result) =>
                    ['chatgpt', 'google'].includes(result.providerId) &&
                    result.status !== 'unmeasured',
                )}
              >
                <summary>
                  <div>
                    <h3 lang={inferContentLang(question.title)}>
                      {question.title}
                    </h3>
                    <div className="ov-question-statuses">
                      {visibility.providers
                        .filter(
                          (provider) =>
                            filter === 'all' || provider.id === filter,
                        )
                        .map((provider) => {
                          const result = question.results.find(
                            (item) => item.providerId === provider.id,
                          );
                          return (
                            <span key={provider.id}>
                              {provider.label}
                              <em className={result?.status ?? 'unmeasured'}>
                                {result
                                  ? resultLabel(result, uiLanguage, isEn)
                                  : isEn
                                    ? 'Unmeasured'
                                    : '未测'}
                              </em>
                            </span>
                          );
                        })}
                    </div>
                  </div>
                  <ChevronDown size={17} />
                </summary>
                <div className="ov-question-record-body">
                  <QuestionResults
                    question={question}
                    visibility={visibility}
                    filter={filter}
                    data={data}
                    onAsset={onAsset}
                    onEvidence={onEvidence}
                  />
                </div>
              </details>
            ))}
          </div>
        </section>
      )}
      {groups.tasks.length > 0 && (
        <footer className="ov-task-entry">
          {groups.tasks.length > 0 && (
            <button type="button" className="og-text-button" onClick={onTask}>
              {isEn
                ? plural(uiLanguage, groups.tasks.length, {
                    one: `${groups.tasks.length} improvement task`,
                    other: `${groups.tasks.length} improvement tasks`,
                  })
                : `${groups.tasks.length} 项改进任务`}{' '}
              <ArrowRight size={14} />
            </button>
          )}
        </footer>
      )}
    </div>
  );
}

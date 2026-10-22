'use client';

import { useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  FileText,
  Search,
} from 'lucide-react';
import type { GeoAsset, GeoState } from '@/lib/geo/types';
import type {
  GeoProviderId,
  GeoVisibility,
  GeoVisibilityQuestion,
  GeoVisibilityResult,
} from '@/lib/geo/visibility-types';

type ProviderFilter = 'all' | GeoProviderId;
type Props = {
  data: GeoState;
  onAsset: (asset: GeoAsset) => void;
  onTask: () => void;
  onQuestions: () => void;
  onEvidence: (path: string) => void;
};

function dateLabel(value: string | null) {
  if (!value) return '未测';
  return new Date(value).toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}
function resultLabel(result: GeoVisibilityResult) {
  if (result.status === 'unmeasured') return '未测';
  if (result.status === 'not_found') return '未找到';
  const ranked = result.sources.find(
    (source) => source.attribution === 'web_result' && source.position !== null,
  );
  if (ranked) return `第 ${ranked.position} 条结果`;
  if (result.sources.some((source) => source.attribution === 'citation'))
    return `引用 ${result.sources.length} 页`;
  if (result.sources.length) return `列出 ${result.sources.length} 个链接`;
  return '已找到';
}
function resultHeadline(result: GeoVisibilityResult, label: string) {
  if (result.status === 'unmeasured') return `${label} 还没有测过这个问题`;
  if (result.status === 'not_found') return `${label} 本次没有找到你的项目`;
  const ranked = result.sources.find(
    (source) => source.attribution === 'web_result' && source.position !== null,
  );
  if (ranked) return `${label} 本次第 ${ranked.position} 条结果是你的项目`;
  if (result.sources.some((source) => source.attribution === 'citation'))
    return `${label} 已识别并引用你的项目`;
  return `${label} 已识别你的项目，并列出了链接`;
}
function domainLabel(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function QuestionResult({
  question,
  visibility,
  filter,
  data,
  onAsset,
  onEvidence,
  featured = false,
}: {
  question: GeoVisibilityQuestion;
  visibility: GeoVisibility;
  filter: ProviderFilter;
  data: GeoState;
  onAsset: Props['onAsset'];
  onEvidence: Props['onEvidence'];
  featured?: boolean;
}) {
  const [selected, setSelected] = useState<GeoProviderId>(
    () =>
      visibility.providers.find((provider) =>
        question.results.some(
          (result) =>
            result.providerId === provider.id &&
            result.status !== 'unmeasured',
        ),
      )?.id ?? 'chatgpt',
  );
  const providers = visibility.providers.filter(
    (provider) => filter === 'all' || provider.id === filter,
  );
  const activeId = filter === 'all' ? selected : filter;
  const result =
    question.results.find((item) => item.providerId === activeId) ??
    question.results[0];
  const activeProvider = visibility.providers.find(
    (provider) => provider.id === result?.providerId,
  );
  if (!result || !activeProvider) return null;
  const related = data.assets.filter((asset) =>
    question.relatedAssetIds.includes(asset.id),
  );
  const hasCitations = result.sources.some(
    (source) => source.attribution === 'citation',
  );

  return (
    <section
      className={`og-question-result ${featured ? 'featured' : ''}`}
      aria-label={question.title}
    >
      {featured && (
        <header className="og-question-result-heading">
          <span className="og-eyebrow">品牌问题 · 已知道项目名字</span>
          <h2>{resultHeadline(result, activeProvider.label)}</h2>
          <p>{question.title}</p>
        </header>
      )}
      <div className="og-provider-tabs" aria-label="查看这个问题的不同入口">
        {providers.map((provider) => {
          const item = question.results.find(
            (entry) => entry.providerId === provider.id,
          );
          if (!item) return null;
          return (
            <button
              key={provider.id}
              type="button"
              className={result.providerId === provider.id ? 'active' : ''}
              aria-pressed={result.providerId === provider.id}
              onClick={() => setSelected(provider.id)}
            >
              <span className="og-provider-name">{provider.label}</span>
              <span className={`og-provider-status ${item.status}`}>
                {item.status === 'found' && <Check size={12} />}
                {resultLabel(item)}
              </span>
            </button>
          );
        })}
      </div>
      <div className="og-provider-result" key={result.providerId}>
        <div className="og-provider-result-meta">
          <span>
            {activeProvider.kind === 'answer' ? 'AI 回答' : '网页搜索'}
            {result.mode ? ` · ${result.mode}` : ''}
          </span>
          <span>
            {result.recordedAt
              ? `${dateLabel(result.recordedAt)} 记录`
              : '尚无记录'}
          </span>
        </div>
        {!featured && (
          <h3 className={result.status === 'found' ? 'found' : ''}>
            {resultHeadline(result, activeProvider.label)}
          </h3>
        )}
        <p className="og-result-summary">{result.summary}</p>
        {result.sources.length > 0 ? (
          <div className="og-result-sources">
            <p className="og-source-caption">
              {activeProvider.kind === 'web'
                ? '找到的项目页面'
                : hasCitations
                  ? '回答中引用的页面'
                  : '回答中列出的项目链接'}
              <span>{result.sources.length}</span>
            </p>
            <div className="og-source-list">
              {result.sources.map((source) => {
                const asset = data.assets.find(
                  (item) => item.id === source.assetId,
                );
                return (
                  <div className="og-source-item" key={source.url}>
                    <a href={source.url} target="_blank" rel="noreferrer">
                      <span className="og-source-symbol">
                        <FileText size={19} />
                      </span>
                      <span className="og-source-copy">
                        <strong>{source.title}</strong>
                        <small>
                          {domainLabel(source.url)}
                          {source.attribution === 'web_result' &&
                          source.position !== null
                            ? ` · 本次第 ${source.position} 条网页结果`
                            : source.attribution === 'citation'
                              ? ' · 回答引用'
                              : ' · 回答所列链接'}
                        </small>
                      </span>
                      <ArrowUpRight size={16} />
                    </a>
                    {asset && (
                      <button
                        type="button"
                        className="og-text-button og-source-read"
                        onClick={() => onAsset(asset)}
                      >
                        阅读已有正文
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="og-result-empty">
            <Search size={18} />
            <span>
              {result.status === 'unmeasured'
                ? '还没有这次回答，暂时无法判断能否找到。'
                : typeof result.searchResultCount === 'number'
                  ? `本次返回 ${result.searchResultCount} 条网页结果，其中没有项目链接。`
                  : '这次结果里没有匹配到项目页面。'}
            </span>
          </div>
        )}
        <details className="og-result-details">
          <summary>
            <span>原始提问与测量说明</span>
            <ChevronDown size={14} />
          </summary>
          <div>
            {result.query && (
              <>
                <span className="og-eyebrow">原始提问</span>
                <p className="og-exact-query">{result.query}</p>
              </>
            )}
            <p>{result.caveat}</p>
            {result.sampleCount > 0 && (
              <p>本条记录包含 {result.sampleCount} 次完成的测量。</p>
            )}
            {result.evidencePath && (
              <button
                type="button"
                className="og-text-button"
                onClick={() => onEvidence(result.evidencePath!)}
              >
                查看本次证据 <ArrowRight size={13} />
              </button>
            )}
            {related.length > 0 && (
              <div className="og-question-related">
                <span>相关已有内容</span>
                {related.map((asset) => (
                  <button
                    type="button"
                    key={asset.id}
                    onClick={() => onAsset(asset)}
                  >
                    {asset.title} <ArrowUpRight size={12} />
                  </button>
                ))}
              </div>
            )}
          </div>
        </details>
      </div>
    </section>
  );
}

export default function VisibilityPanel({
  data,
  onAsset,
  onTask,
  onQuestions,
  onEvidence,
}: Props) {
  const [filter, setFilter] = useState<ProviderFilter>('all');
  const visibility = data.visibility;
  if (!visibility?.questions.length)
    return <div className="og-loading">正在整理各入口的测量结果…</div>;
  const featured = visibility.questions[0];
  const otherQuestions = visibility.questions.slice(1);
  const activeLabel =
    visibility.providers.find((provider) => provider.id === filter)?.label ??
    '各入口';
  const otherMeasured = otherQuestions.filter((question) =>
    question.results.some(
      (result) =>
        (filter === 'all' || result.providerId === filter) &&
        result.status !== 'unmeasured',
    ),
  ).length;

  return (
    <div className="og-multisearch">
      <header className="og-page-heading og-search-heading">
        <div>
          <span className="og-eyebrow">ContextAdapt</span>
          <h1>当前可见性</h1>
        </div>
        <label className="og-provider-filter">
          <span>搜索入口</span>
          <span className="og-provider-select-wrap">
            <select
              aria-label="筛选搜索入口"
              value={filter}
              onChange={(event) =>
                setFilter(event.target.value as ProviderFilter)
              }
            >
              <option value="all">全部入口</option>
              {visibility.providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.label}
                </option>
              ))}
            </select>
            <ChevronDown size={14} />
          </span>
        </label>
      </header>
      <div className="og-question-entry">
        <div>
          <strong>先确定搜什么</strong>
          <p>{data.questionPlan.candidates.length} 道候选 · {data.questionPlan.candidates.filter(item => item.selected).length} 道已选 · {data.questionPlan.status === 'ready' ? '题单已确认，尚未采集' : '待确认'}</p>
        </div>
        <button className="og-button secondary" onClick={onQuestions}>
          审阅题单 <ArrowRight size={15} />
        </button>
      </div>
      <QuestionResult
        key={`${featured.id}-${filter}`}
        question={featured}
        visibility={visibility}
        filter={filter}
        data={data}
        onAsset={onAsset}
        onEvidence={onEvidence}
        featured
      />
      <p className="og-search-scope">
        这是品牌提问下的结果；还不能代表用户不提项目名时也能找到。默认顺序为
        ChatGPT、Google、Gemini、DeepSeek。
      </p>
      <details className="og-other-questions" key={filter}>
        <summary>
          <div>
            <strong>其他问题的结果</strong>
            <p>
              {otherQuestions.length} 条问法 ·{' '}
              {filter === 'all'
                ? '目前仅 DeepSeek 有测量记录'
                : `${activeLabel} 已测 ${otherMeasured} 条`}
            </p>
          </div>
          <span>
            展开 <ChevronDown size={15} />
          </span>
        </summary>
        <div className="og-other-question-list">
          <p className="og-query-set-note">
            原题单含同一问题的中英文版本，场景问法仍待完善。未测显示“未测”。
          </p>
          {otherQuestions.map((question) => (
            <details className="og-question-row" key={question.id}>
              <summary>
                <div className="og-question-row-title">
                  <span>{question.kind === 'brand' ? '品牌' : '场景'}</span>
                  <strong>{question.title}</strong>
                </div>
                <div className="og-question-row-statuses">
                  {visibility.providers
                    .filter(
                      (provider) => filter === 'all' || provider.id === filter,
                    )
                    .map((provider) => {
                      const result = question.results.find(
                        (entry) => entry.providerId === provider.id,
                      );
                      return result ? (
                        <span key={provider.id}>
                          {provider.label}
                          <em className={result.status}>
                            {resultLabel(result)}
                          </em>
                        </span>
                      ) : null;
                    })}
                </div>
                <ChevronDown size={15} />
              </summary>
              <QuestionResult
                question={question}
                visibility={visibility}
                filter={filter}
                data={data}
                onAsset={onAsset}
                onEvidence={onEvidence}
              />
            </details>
          ))}
        </div>
      </details>
      <div className="og-search-next">
        <div>
          <strong>已有改进任务</strong>
          <p>继续查看已保存的方案与观察记录。</p>
        </div>
        <button type="button" className="og-text-button" onClick={onTask}>
          查看改进任务 <ArrowRight size={14} />
        </button>
      </div>
    </div>
  );
}

'use client';

import { useMemo, useRef, useState, useEffect } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  FileText,
  Link2,
  Search,
  X,
} from 'lucide-react';
import type {
  GeoAsset,
  GeoState,
  ResearchTaskContext,
  AssetGovernanceInput,
} from '@/lib/geo/types';
import {
  buildContentWorkspace,
  countContentReferences,
  normalizeContentUrl,
  type ContentItem,
  type ContentReference,
  type ContentGovernanceItem,
  type ContentGapCategory,
} from '@/lib/geo/content-assets';
import ContentEvidence, { contentWebUrl } from './ContentEvidence';
import AssetGovernancePanel from './AssetGovernancePanel';
import './content-assets.css';

type Props = {
  data: GeoState;
  onAsset: (asset: GeoAsset) => void;
  onTask: () => void;
  onImprove?: (context: ResearchTaskContext) => void;
  onGovernance?: (input: AssetGovernanceInput) => Promise<void> | void;
  onOpenTask?: (id: string) => void;
};
type Language = 'zh' | 'en';
type SourceEngine = 'chatgpt' | 'google';
type Measured = { chatgpt: boolean; google: boolean };
type PageTab = 'owned' | 'external' | 'gaps';
type DetailTab = 'coverage' | 'references' | 'evidence';
type Selection =
  | {
      item: ContentItem;
      detailTab?: DetailTab;
      sourceEngine?: SourceEngine;
      observationIndex?: number;
      observationQuestion?: string;
    }
  | { gap: ContentGovernanceItem };
const typeNames: Record<string, string> = {
  article: '文章',
  guide: '指南',
  research: '研究',
  homepage: '首页',
  documentation: '文档',
  social_article: '社媒长文',
  social_post: '社媒发布',
  source_page: '网页',
};
const kindNames = {
  official: '官方来源',
  other: '第三方',
  self_submission: '自荐',
  mirror: '镜像',
};
const gapNames: Record<ContentGapCategory, string> = {
  content: '内容缺口',
  evidence: '证据缺口',
  capability: '能力缺口',
  investigate: '待调查',
};
const languageName = (language: string) =>
  language.startsWith('zh')
    ? '中文'
    : language === 'en'
      ? '英文'
      : '语言未标注';
const domain = (url: string | null) => {
  const safe = contentWebUrl(url);
  return safe ? new URL(safe).hostname : '无公开链接';
};
const refsIn = (item: ContentItem, language: Language, engine?: SourceEngine) =>
  item.references.filter(
    (ref) =>
      ref.observation.language === language &&
      (!engine || ref.observation.engine === engine),
  );
const observationIndex = (ref: ContentReference) =>
  Number(ref.observationId.match(/:observation:(\d+)$/)?.[1] ?? -1);
function answerHref(ref: ContentReference) {
  const params = new URLSearchParams({
    view: 'questions',
    project: ref.projectId,
    batch: ref.batchId,
    question: ref.questionId,
    language: ref.observation.language,
    engine: ref.observation.engine,
    sourceUrl: ref.source.url,
    observationIndex: String(observationIndex(ref)),
    detail: 'answer',
  });
  if (typeof window !== 'undefined') {
    const returnUrl = new URL(window.location.href);
    returnUrl.searchParams.delete('returnTo');
    params.set('returnTo', returnUrl.pathname + returnUrl.search);
  }
  return '/?' + params.toString();
}
function domainGroups(
  items: ContentItem[],
  language: Language,
  engine: SourceEngine,
) {
  const grouped = new Map<string, ContentItem[]>();
  for (const item of items) {
    if (!refsIn(item, language, engine).length) continue;
    if (!contentWebUrl(item.url)) continue;
    const hostname = domain(item.url);
    grouped.set(hostname, [...(grouped.get(hostname) || []), item]);
  }
  return [...grouped]
    .map(([hostname, pages]) => {
      const counts = countContentReferences(
        pages.flatMap((page) => refsIn(page, language, engine)),
      );
      return {
        hostname,
        pages,
        counts,
        count:
          engine === 'chatgpt'
            ? counts.chatgptAnswers
            : counts.googleResults + counts.googleOtherSources,
      };
    })
    .sort((a, b) => b.count - a.count || a.hostname.localeCompare(b.hostname));
}
const questionHref = (
  project: string,
  question: string,
  language: Language,
  engine: SourceEngine | 'all' = 'all',
) =>
  '/?' +
  new URLSearchParams({
    view: 'questions',
    project,
    question,
    language,
    engine,
  });

function SourceBars({
  title,
  items,
  language,
  engine,
  max,
  measured,
  onSelect,
  onDomain,
}: {
  title: string;
  items: ContentItem[];
  language: Language;
  engine: SourceEngine;
  max: number;
  measured: boolean;
  onSelect: (item: ContentItem) => void;
  onDomain?: (hostname: string) => void;
}) {
  const ranked = onDomain
    ? domainGroups(items, language, engine)
        .slice(0, 4)
        .map((group) => ({
          item: group.pages[0],
          count: group.count,
          label: group.hostname,
        }))
    : items
        .map((item) => ({
          item,
          label: item.title,
          count: (() => {
            const counts = countContentReferences(
              refsIn(item, language, engine),
            );
            return engine === 'chatgpt'
              ? counts.chatgptAnswers
              : counts.googleResults + counts.googleOtherSources;
          })(),
        }))
        .filter(({ count }) => count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 4);
  return (
    <section className="ka-source-chart">
      <header>
        <h2>{title}</h2>
        <span>{engine === 'chatgpt' ? '涉及回答' : '来源条目'}</span>
      </header>
      {ranked.length ? (
        ranked.map(({ item, count, label }, index) => (
          <button
            key={item.id}
            onClick={() => (onDomain ? onDomain(label) : onSelect(item))}
            className="ka-source-bar"
            title={label}
          >
            <span className="ka-bar-rank">{index + 1}</span>
            <span className="ka-bar-label">{label}</span>
            <strong>{count}</strong>
            <span className="ka-bar-track">
              <i
                style={{
                  width: `${(count / Math.max(max, ...ranked.map((row) => row.count))) * 100}%`,
                }}
              />
            </span>
          </button>
        ))
      ) : (
        <p className="ka-chart-empty">
          {measured
            ? `本批${languageName(language)}${engine === 'chatgpt' ? '回答' : '搜索'}未记录这类来源`
            : `尚无${languageName(language)} ${engine === 'chatgpt' ? 'ChatGPT' : 'Google'} 观测`}
        </p>
      )}
    </section>
  );
}

function ReferenceList({
  item,
  language,
  engine,
  selectedObservation,
  selectedQuestion,
}: {
  item: ContentItem;
  language: Language;
  engine: SourceEngine;
  selectedObservation?: number;
  selectedQuestion?: string;
}) {
  const rows = new Map<string, ContentReference[]>();
  for (const ref of refsIn(item, language, engine))
    rows.set(ref.observationId, [...(rows.get(ref.observationId) || []), ref]);
  return (
    <div className="ka-reference-list">
      {[...rows].map(([id, refs]) => {
        const ref = refs[0];
        return (
          <article
            key={id}
            className={
              'ka-reference' +
              (selectedObservation === observationIndex(ref) &&
              (!selectedQuestion || selectedQuestion === ref.questionId)
                ? ' is-current'
                : '')
            }
          >
            <header>
              <strong>
                {ref.observation.engine === 'chatgpt' ? 'ChatGPT' : 'Google'}
              </strong>
              <span>{languageName(ref.observation.language)}</span>
              <a
                href={answerHref(ref)}
                onClick={(event) => {
                  event.currentTarget.href = answerHref(ref);
                }}
              >
                {ref.observation.engine === 'google' ? '搜索记录' : '查看回答'}{' '}
                <ArrowUpRight size={13} />
              </a>
            </header>
            <h3>{ref.observation.query}</h3>
            <p>{ref.observation.summary}</p>
            <ul>
              {refs.map((entry) => (
                <li key={entry.id}>
                  <span>
                    {entry.observation.engine === 'google'
                      ? entry.source.position !== undefined
                        ? `网页第 ${entry.source.position} 条`
                        : '其他已保存来源'
                      : '回答中的来源'}
                  </span>
                  {contentWebUrl(entry.source.url) ? (
                    <a
                      href={contentWebUrl(entry.source.url)!}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {entry.source.title || entry.source.url}
                      <ArrowUpRight size={12} />
                    </a>
                  ) : (
                    <span>{entry.source.url}</span>
                  )}
                  <small>{kindNames[entry.source.kind]}</small>
                </li>
              ))}
            </ul>
            <details className="ka-record-conditions">
              <summary>时间与采集条件</summary>
              <p>{ref.observation.recordedAt}</p>
              <p>{ref.observation.conditions}</p>
            </details>
            <ContentEvidence
              projectId={item.projectId}
              path={ref.observation.answerPath || ref.observation.evidencePath}
              label="已保存的原始记录"
            />
          </article>
        );
      })}
      {!rows.size && (
        <div className="ka-empty">
          本批{languageName(language)}{' '}
          {engine === 'chatgpt' ? 'ChatGPT' : 'Google'}
          观测里，没有这页的来源记录。
        </div>
      )}
    </div>
  );
}

function ItemDetail({
  item,
  language,
  onAsset,
  detailTab = 'coverage',
  referenceEngine = 'chatgpt',
  onDetailChange,
  measured,
  selectedObservation,
  selectedQuestion,
}: {
  item: ContentItem;
  language: Language;
  onAsset: Props['onAsset'];
  detailTab?: DetailTab;
  referenceEngine?: SourceEngine;
  onDetailChange: (tab: DetailTab, engine: SourceEngine) => void;
  measured: Measured;
  selectedObservation?: number;
  selectedQuestion?: string;
}) {
  const setDetailTab = (tab: DetailTab) => onDetailChange(tab, referenceEngine);
  const setReferenceEngine = (engine: SourceEngine) =>
    onDetailChange(detailTab, engine);
  const counts = countContentReferences(refsIn(item, language));
  const url = contentWebUrl(item.url);
  const showReferences = (engine: SourceEngine) => {
    onDetailChange('references', engine);
  };
  return (
    <>
      <div className="ka-detail-intro">
        <div className="ka-tags">
          <span>
            {item.ownership === 'owned'
              ? '我方材料'
              : item.ownership === 'unknown'
                ? '归属待核实'
                : '外部来源'}
          </span>
          {item.kinds.map((kind) => (
            <span key={kind}>{kindNames[kind]}</span>
          ))}
          {item.asset && <span>{languageName(item.asset.language)}</span>}
        </div>
        {item.summary && <p>{item.summary}</p>}
        <div className="ka-detail-actions">
          {item.asset && (
            <button className="ka-primary" onClick={() => onAsset(item.asset!)}>
              <BookOpen size={15} />
              阅读已保存正文
            </button>
          )}
          {url && (
            <a href={url} target="_blank" rel="noreferrer">
              打开网页
              <ArrowUpRight size={14} />
            </a>
          )}
        </div>
        {!item.asset && (
          <p className="ka-muted">已保存来源链接，尚未收录页面正文。</p>
        )}
      </div>
      <div className="ka-detail-metrics">
        <button onClick={() => showReferences('chatgpt')}>
          <strong>{measured.chatgpt ? counts.chatgptAnswers : '—'}</strong>
          <span>ChatGPT 回答</span>
        </button>
        <button onClick={() => showReferences('chatgpt')}>
          <strong>{measured.chatgpt ? counts.chatgptCitations : '—'}</strong>
          <span>ChatGPT 来源条目</span>
        </button>
        <button onClick={() => showReferences('google')}>
          <strong>{measured.google ? counts.googleResults : '—'}</strong>
          <span>Google 网页结果</span>
        </button>
      </div>
      <nav className="ka-tabs ka-detail-tabs" aria-label="资产详情">
        <button
          aria-pressed={detailTab === 'coverage'}
          onClick={() => setDetailTab('coverage')}
        >
          内容与问题
        </button>
        <button
          aria-pressed={detailTab === 'references'}
          onClick={() => setDetailTab('references')}
        >
          来源记录
        </button>
        <button
          aria-pressed={detailTab === 'evidence'}
          onClick={() => setDetailTab('evidence')}
        >
          资料依据
        </button>
      </nav>
      {detailTab === 'coverage' && (
        <div className="ka-detail-section">
          {item.topics.length > 0 && (
            <section>
              <h3>正文主题</h3>
              <div className="ka-topics">
                {item.topics.map((topic) => (
                  <span key={topic}>{topic}</span>
                ))}
              </div>
            </section>
          )}
          <section>
            <h3>承接问题</h3>
            {item.coverage.length ? (
              item.coverage.map((coverage) => (
                <article className="ka-coverage" key={coverage.question.id}>
                  <a
                    href={questionHref(
                      item.projectId,
                      coverage.question.id,
                      language,
                      referenceEngine,
                    )}
                  >
                    {coverage.question[language]}
                    <ArrowUpRight size={13} />
                  </a>
                  <details>
                    <summary>
                      {coverage.status === 'documented'
                        ? '承接范围与依据'
                        : '候选关联 · 待核对'}
                    </summary>
                    <p>{coverage.question.answerability}</p>
                    <p>{coverage.basis}</p>
                    <ContentEvidence
                      projectId={item.projectId}
                      path={coverage.evidencePath}
                      label="审阅原文"
                    />
                  </details>
                </article>
              ))
            ) : (
              <p className="ka-muted">还没有核对这页能够承接哪些问题。</p>
            )}
          </section>
          <section>
            <h3>出现记录</h3>
            <div className="ka-question-links">
              {item.questions
                .filter((relation) =>
                  relation.references.some(
                    (ref) =>
                      ref.observation.language === language &&
                      ref.observation.engine === referenceEngine,
                  ),
                )
                .map((relation) => (
                  <a
                    key={relation.key}
                    href={questionHref(
                      item.projectId,
                      relation.question.id,
                      language,
                      referenceEngine,
                    )}
                  >
                    {relation.question[language]}
                    <ArrowUpRight size={13} />
                  </a>
                ))}
            </div>
            {!refsIn(item, language, referenceEngine).length && (
              <p className="ka-muted">
                本批{languageName(language)}{' '}
                {referenceEngine === 'chatgpt' ? 'ChatGPT' : 'Google'}{' '}
                观测未出现此页。
              </p>
            )}
          </section>
          {item.recordedMappings.length > 0 && (
            <details className="ka-legacy">
              <summary>历史内容关联 · {item.recordedMappings.length}</summary>
              {item.recordedMappings.map(({ id, question }) => (
                <div key={id}>
                  <p>{question.query}</p>
                  <small>
                    {question.provider} · {question.measurementAt}
                  </small>
                </div>
              ))}
              <p>历史题目关联，不能证明这页曾被引用。</p>
            </details>
          )}
        </div>
      )}
      {detailTab === 'references' && (
        <div className="ka-detail-section">
          <nav className="ka-source-switch" aria-label="来源记录入口">
            <button
              aria-pressed={referenceEngine === 'chatgpt'}
              onClick={() => setReferenceEngine('chatgpt')}
            >
              ChatGPT 回答{' '}
              <span>{measured.chatgpt ? counts.chatgptAnswers : '—'}</span>
            </button>
            <button
              aria-pressed={referenceEngine === 'google'}
              onClick={() => setReferenceEngine('google')}
            >
              Google 搜索{' '}
              <span>{measured.google ? counts.googleSearches : '—'}</span>
            </button>
          </nav>
          <ReferenceList
            item={item}
            language={language}
            engine={referenceEngine}
            selectedObservation={selectedObservation}
            selectedQuestion={selectedQuestion}
          />
        </div>
      )}
      {detailTab === 'evidence' && (
        <div className="ka-detail-section">
          <dl className="ka-metadata">
            <div>
              <dt>页面身份</dt>
              <dd>{item.ownershipBasis}</dd>
            </div>
            {item.asset && (
              <>
                <div>
                  <dt>材料状态</dt>
                  <dd>
                    {item.asset.status === 'published'
                      ? '已发布'
                      : item.asset.status === 'draft'
                        ? '草稿'
                        : item.asset.status}
                  </dd>
                </div>
                <div>
                  <dt>发布记录</dt>
                  <dd>{item.asset.publishedAt || '未记录日期'}</dd>
                </div>
              </>
            )}
          </dl>
          {item.urls.length > 0 && (
            <details>
              <summary>原始链接 · {item.urls.length}</summary>
              <ul className="ka-original-urls">
                {item.urls.map((link) => (
                  <li key={link}>
                    {contentWebUrl(link) ? (
                      <a
                        href={contentWebUrl(link)!}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {link}
                      </a>
                    ) : (
                      link
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <h3>已保存的依据</h3>
          {item.evidencePaths.map((path, index) => (
            <ContentEvidence
              key={path}
              projectId={item.projectId}
              path={path}
              label={`查看依据 ${index + 1}`}
            />
          ))}
          {!item.evidencePaths.length && (
            <p className="ka-muted">暂无已保存的材料。</p>
          )}
        </div>
      )}
    </>
  );
}

function GapDetail({
  gap,
  language,
  engine,
  data,
  onImprove,
  onGovernance,
  onOpenTask,
}: {
  gap: ContentGovernanceItem;
  language: Language;
  engine: SourceEngine;
  data: GeoState;
  onImprove?: Props['onImprove'];
  onGovernance?: Props['onGovernance'];
  onOpenTask?: Props['onOpenTask'];
}) {
  return (
    <div className="ka-detail-section">
      <p className="ka-gap-request">{gap.text}</p>
      <section>
        <h3>对应的问题</h3>
        <a
          className="ka-question-link"
          href={questionHref(gap.projectId, gap.question.id, language, engine)}
        >
          {gap.question[language]}
          <ArrowUpRight size={14} />
        </a>
      </section>
      <details className="ka-gap-basis">
        <summary>承接边界与判断依据</summary>
        <section>
          <h3>目前能回答到哪里</h3>
          <p>{gap.question.answerability}</p>
        </section>
        <section>
          <h3>为什么值得补</h3>
          <p>{gap.question.valueReason}</p>
        </section>
        <section>
          <h3>判断依据</h3>
          <p>
            {gap.question.evidenceBasis.replace(
              /\b(user_context|observed|inferred)\s*[:：]/g,
              (label) =>
                label.startsWith('user_context')
                  ? '用户给定：'
                  : label.startsWith('observed')
                    ? '公开观测：'
                    : '推导：',
            )}
          </p>
          <ContentEvidence
            projectId={gap.projectId}
            path={gap.reviewPath}
            label="查看审阅原文"
          />
        </section>
      </details>
      <AssetGovernancePanel
        gap={gap}
        data={data}
        language={language}
        engine={engine}
        onImprove={onImprove}
        onGovernance={onGovernance}
        onOpenTask={onOpenTask}
      />
    </div>
  );
}

function AssetWorkspace({
  data,
  onAsset,
  onTask,
  onImprove,
  onGovernance,
  onOpenTask,
}: Props) {
  const workspace = useMemo(() => buildContentWorkspace(data), [data]);
  const [tab, setTab] = useState<PageTab>('owned');
  const [language, setLanguage] = useState<Language>('zh');
  const [sourceEngine, setSourceEngine] = useState<SourceEngine>('chatgpt');
  const [query, setQuery] = useState('');
  const [assetType, setAssetType] = useState('all');
  const [gapFilter, setGapFilter] = useState<ContentGapCategory | 'all'>('all');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [sourceLimit, setSourceLimit] = useState(24);
  const [sourceLevel, setSourceLevel] = useState<'websites' | 'pages'>(
    'websites',
  );
  const [sourceDomain, setSourceDomain] = useState('');
  const [deepLinkWarning, setDeepLinkWarning] = useState('');
  const [unsupportedEngine, setUnsupportedEngine] = useState(false);
  const [locationReady, setLocationReady] = useState(false);
  const drawer = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const readLocation = () => {
      const params = new URLSearchParams(window.location.search);
      if (
        params.get('view') !== 'assets' ||
        (params.get('project') || 'example-project') !== data.project.id
      )
        return;
      setLanguage(params.get('language') === 'en' ? 'en' : 'zh');
      const requestedEngine = params.get('assetEngine') || params.get('engine');
      if (
        requestedEngine &&
        !['chatgpt', 'google', 'all'].includes(requestedEngine)
      ) {
        setUnsupportedEngine(true);
        setLocationReady(false);
        setSelection(null);
        return;
      }
      setUnsupportedEngine(false);
      const engine = requestedEngine === 'google' ? 'google' : 'chatgpt';
      setSourceEngine(engine);
      // Asset-specific filters belong to one project; language and platform can carry across pages.
      if (
        !params.has('assetProject') ||
        params.get('assetProject') === data.project.id
      ) {
        const pageTab = params.get('assetTab');
        setTab(
          pageTab === 'external' || pageTab === 'gaps' ? pageTab : 'owned',
        );
        setQuery(params.get('assetQuery') || '');
        setSourceLevel(
          params.get('assetLevel') === 'pages' ? 'pages' : 'websites',
        );
        setSourceDomain(params.get('assetDomain') || '');
        const type = params.get('assetType');
        setAssetType(
          type && workspace.items.some((item) => item.type === type)
            ? type
            : 'all',
        );
        const filter = params.get('assetGapFilter');
        setGapFilter(
          filter && Object.hasOwn(gapNames, filter)
            ? (filter as ContentGapCategory)
            : 'all',
        );
        const limit = Number(params.get('assetLimit'));
        setSourceLimit(
          Number.isInteger(limit) && limit > 24
            ? Math.min(limit, Math.max(24, workspace.items.length))
            : 24,
        );
        const source = normalizeContentUrl(
          params.get('assetUrl') || params.get('source'),
        );
        const batchMatches =
          !params.get('batch') || params.get('batch') === workspace.batch?.id;
        setDeepLinkWarning(
          !batchMatches ? '这条链接来自其他观测批次；当前仅展示本批记录。' : '',
        );
        const item = workspace.items.find((entry) =>
          source
            ? [entry.url, ...entry.urls].some(
                (url) => normalizeContentUrl(url) === source,
              )
            : entry.id === params.get('assetId'),
        );
        const gap = workspace.governance.find(
          (entry) => entry.id === params.get('assetGap'),
        );
        if (item && batchMatches) {
          if (source) setTab(item.ownership === 'owned' ? 'owned' : 'external');
          const detail = params.get('assetDetail');
          setSelection({
            item,
            detailTab:
              detail === 'coverage' ||
              detail === 'references' ||
              detail === 'evidence'
                ? detail
                : source
                  ? 'references'
                  : 'coverage',
            sourceEngine:
              params.get('assetEngine') === 'google'
                ? 'google'
                : params.get('assetEngine') === 'chatgpt'
                  ? 'chatgpt'
                  : engine,
            observationIndex:
              params.has('observationIndex') &&
              Number.isInteger(Number(params.get('observationIndex')))
                ? Number(params.get('observationIndex'))
                : undefined,
            observationQuestion:
              params.get('assetQuestion') ||
              params.get('question') ||
              undefined,
          });
        } else if (gap) setSelection({ gap });
        else {
          setSelection(null);
          if (source && batchMatches)
            setDeepLinkWarning('当前项目尚未保存这个来源页面。');
        }
      }
      setLocationReady(true);
    };
    readLocation();
    window.addEventListener('popstate', readLocation);
    return () => window.removeEventListener('popstate', readLocation);
  }, [data.project.id, workspace]);
  useEffect(() => {
    if (!locationReady) return;
    const url = new URL(window.location.href);
    if (
      url.searchParams.get('view') !== 'assets' ||
      (url.searchParams.get('project') || 'example-project') !== data.project.id
    )
      return;
    const values: Record<string, string | null> = {
      language,
      engine: sourceEngine,
      assetProject: data.project.id,
      assetTab: tab === 'owned' ? null : tab,
      assetQuery: query || null,
      assetType: assetType === 'all' ? null : assetType,
      assetGapFilter: gapFilter === 'all' ? null : gapFilter,
      assetLimit: sourceLimit > 24 ? String(sourceLimit) : null,
      assetLevel: sourceLevel === 'pages' ? 'pages' : null,
      assetDomain: sourceDomain || null,
      assetId: selection && 'item' in selection ? selection.item.id : null,
      assetGap: selection && 'gap' in selection ? selection.gap.id : null,
      assetDetail:
        selection && 'item' in selection
          ? selection.detailTab || 'coverage'
          : null,
      assetEngine:
        selection && 'item' in selection
          ? selection.sourceEngine || sourceEngine
          : null,
      assetUrl: selection && 'item' in selection ? selection.item.url : null,
      assetQuestion:
        selection && 'item' in selection
          ? selection.observationQuestion || null
          : null,
      observationIndex:
        selection &&
        'item' in selection &&
        selection.observationIndex !== undefined
          ? String(selection.observationIndex)
          : null,
    };
    for (const [key, value] of Object.entries(values)) {
      if (value === null) url.searchParams.delete(key);
      else url.searchParams.set(key, value);
    }
    url.searchParams.delete('source');
    if (url.href !== window.location.href)
      window.history.replaceState(null, '', url);
  }, [
    locationReady,
    data.project.id,
    language,
    sourceEngine,
    tab,
    query,
    assetType,
    gapFilter,
    sourceLimit,
    sourceLevel,
    sourceDomain,
    selection,
  ]);
  useEffect(() => {
    if (selection && !drawer.current?.open) drawer.current?.showModal();
    else if (!selection && drawer.current?.open) drawer.current.close();
  }, [selection]);
  const owned = workspace.items.filter((item) => item.ownership === 'owned');
  const external = workspace.items.filter((item) => item.ownership !== 'owned');
  const externalInScope = external.filter(
    (item) => refsIn(item, language, sourceEngine).length > 0,
  );
  const externalDomains = domainGroups(externalInScope, language, sourceEngine);
  const measured: Measured = {
    chatgpt: Boolean(
      workspace.batch?.questions.some((question) =>
        question.observations.some(
          (observation) =>
            observation.language === language &&
            observation.engine === 'chatgpt',
        ),
      ),
    ),
    google: Boolean(
      workspace.batch?.questions.some((question) =>
        question.observations.some(
          (observation) =>
            observation.language === language &&
            observation.engine === 'google',
        ),
      ),
    ),
  };
  const saved = owned.filter((item) => item.asset);
  const sourceOnly = owned.filter((item) => !item.asset);
  const sourcesInScope = workspace.items.filter(
    (item) => refsIn(item, language, sourceEngine).length > 0,
  );
  const ownedInScope = sourcesInScope.filter(
    (item) => item.ownership === 'owned',
  );
  const hasUnknownOwnership = externalInScope.some(
    (item) => item.ownership === 'unknown',
  );
  const maxAnswers = Math.max(
    1,
    ...sourcesInScope.map((item) => {
      const counts = countContentReferences(
        refsIn(item, language, sourceEngine),
      );
      return sourceEngine === 'chatgpt'
        ? counts.chatgptAnswers
        : counts.googleResults + counts.googleOtherSources;
    }),
  );
  const matches = (item: ContentItem) => {
    const questions = [
      ...item.questions
        .filter((relation) =>
          relation.references.some(
            (ref) =>
              ref.observation.language === language &&
              ref.observation.engine === sourceEngine,
          ),
        )
        .map((relation) => relation.question),
      ...item.coverage.map((coverage) => coverage.question),
    ];
    return (
      (assetType === 'all' || item.type === assetType) &&
      `${item.title} ${item.summary} ${item.url || ''} ${questions.map((question) => question.id + question.zh + question.en).join(' ')}`
        .toLowerCase()
        .includes(query.toLowerCase())
    );
  };
  const sourceCount = (item: ContentItem) => {
    const counts = countContentReferences(refsIn(item, language, sourceEngine));
    return sourceEngine === 'chatgpt'
      ? counts.chatgptAnswers
      : counts.googleResults + counts.googleOtherSources;
  };
  const visible = (
    tab === 'owned'
      ? saved
      : externalInScope.filter(
          (item) => !sourceDomain || domain(item.url) === sourceDomain,
        )
  )
    .filter(matches)
    .sort((a, b) => sourceCount(b) - sourceCount(a));
  const sourceLinks = sourceOnly.filter(matches);
  const visibleDomains = externalDomains.filter(
    (group) =>
      group.hostname.toLowerCase().includes(query.toLowerCase()) ||
      group.pages.some(matches),
  );
  const gaps = workspace.governance.filter(
    (gap) =>
      (gapFilter === 'all' || gap.category === gapFilter) &&
      `${gap.text} ${gap.question.id} ${gap.question.zh} ${gap.question.en}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const availableTypes = [
    ...new Set(
      (tab === 'owned' ? saved : externalInScope).map((item) => item.type),
    ),
  ];
  const openItem = (
    item: ContentItem,
    detailTab: DetailTab = 'coverage',
    engine: SourceEngine = sourceEngine,
  ) => setSelection({ item, detailTab, sourceEngine: engine });
  const openDomain = (hostname: string) => {
    setTab('external');
    setSourceLevel('pages');
    setSourceDomain(hostname);
    setAssetType('all');
    setSourceLimit(24);
    setQuery('');
  };

  const changeSourceEngine = (engine: SourceEngine) => {
    setSourceEngine(engine);
    setAssetType('all');
    setSourceLimit(24);
  };

  function renderItem(item: ContentItem) {
    const references = refsIn(item, language, sourceEngine);
    const counts = countContentReferences(references);
    const positions = [
      ...new Set(
        references.flatMap((ref) =>
          ref.observation.engine === 'google' &&
          ref.source.position !== undefined
            ? [ref.source.position]
            : [],
        ),
      ),
    ].sort((a, b) => a - b);
    const questionIds = [
      ...new Set([
        ...item.coverage.map((entry) => entry.question.id),
        ...item.questions
          .filter((relation) =>
            relation.references.some(
              (ref) =>
                ref.observation.language === language &&
                ref.observation.engine === sourceEngine,
            ),
          )
          .map((relation) => relation.question.id),
      ]),
    ];
    const questionLinks = questionIds.map((id) => {
      const question =
        item.coverage.find((entry) => entry.question.id === id)?.question ||
        item.questions.find((entry) => entry.question.id === id)?.question;
      const title = question?.[language] || '查看相关问题';
      return (
        <a
          key={id}
          title={title}
          aria-label={title}
          href={questionHref(data.project.id, id, language, sourceEngine)}
        >
          {title}
        </a>
      );
    });
    return (
      <article className="ka-asset-row" key={item.id}>
        <div className={'ka-file-icon ' + (item.asset ? 'saved' : '')}>
          {item.asset ? <FileText size={20} /> : <Link2 size={19} />}
        </div>
        <div className="ka-asset-main">
          <button className="ka-asset-title" onClick={() => openItem(item)}>
            {item.title}
            <ArrowUpRight size={14} />
          </button>
          <div className="ka-asset-meta">
            <span>{typeNames[item.type] || item.type}</span>
            {item.asset ? (
              <span>{languageName(item.language)}</span>
            ) : (
              <span>
                {item.ownership === 'unknown'
                  ? '归属待核实'
                  : item.ownership === 'owned'
                    ? '正文待收录'
                    : kindNames[item.kind]}
              </span>
            )}
            <span>{domain(item.url)}</span>
          </div>
        </div>
        <div className="ka-row-questions">
          {questionLinks[0] || <span>待关联</span>}
          {questionLinks.length > 1 && (
            <details>
              <summary>另 {questionLinks.length - 1} 个问题</summary>
              <div>{questionLinks.slice(1)}</div>
            </details>
          )}
        </div>
        <button
          className={'ka-row-counts ' + (references.length ? 'found' : '')}
          onClick={() => openItem(item, 'references')}
        >
          <strong>
            {sourceEngine === 'google'
              ? counts.googleResults
                ? `${counts.googleResults} 条网页结果`
                : counts.googleOtherSources
                  ? `${counts.googleOtherSources} 条其他来源`
                  : measured.google
                    ? '未见结果'
                    : '尚无观测'
              : counts.chatgptAnswers
                ? `${counts.chatgptAnswers} 条回答`
                : measured.chatgpt
                  ? '未见引用'
                  : '尚无观测'}
          </strong>
          <span>
            {sourceEngine === 'google'
              ? positions.length
                ? `网页第 ${positions.slice(0, 4).join('、')}${positions.length > 4 ? '…' : ''} 条${counts.googleOtherSources ? ` · 另 ${counts.googleOtherSources} 条来源` : ''}`
                : null
              : counts.chatgptCitations > 0
                ? `${counts.chatgptCitations} 个来源条目`
                : null}
          </span>
        </button>
      </article>
    );
  }

  if (unsupportedEngine)
    return (
      <div className="ka-workspace">
        <p role="status">
          内容资产目前仅汇总 ChatGPT 与 Google
          观测。该入口的来源请在问题详情查看。
        </p>
        <button
          onClick={() => {
            setUnsupportedEngine(false);
            setLocationReady(true);
            changeSourceEngine('chatgpt');
          }}
        >
          查看 ChatGPT 观测
        </button>
        <button
          onClick={() => {
            setUnsupportedEngine(false);
            setLocationReady(true);
            changeSourceEngine('google');
          }}
        >
          查看 Google 观测
        </button>
      </div>
    );

  return (
    <div className="ka-workspace">
      <header className="ka-heading">
        <div className="ka-heading-title">
          <h1>内容资产</h1>
          <span className="ka-batch-date">
            {workspace.batch?.date || '暂无观测批次'}
          </span>
        </div>
        <div className="ka-heading-controls">
          <nav className="ka-source-switch" aria-label="来源入口">
            <button
              aria-pressed={sourceEngine === 'chatgpt'}
              onClick={() => changeSourceEngine('chatgpt')}
            >
              ChatGPT 回答
            </button>
            <button
              aria-pressed={sourceEngine === 'google'}
              onClick={() => changeSourceEngine('google')}
            >
              Google 搜索结果
            </button>
          </nav>
          <div className="ka-language" aria-label="查询语言">
            <button
              aria-pressed={language === 'zh'}
              onClick={() => setLanguage('zh')}
            >
              中文
            </button>
            <button
              aria-pressed={language === 'en'}
              onClick={() => setLanguage('en')}
            >
              英文
            </button>
          </div>
        </div>
      </header>
      {workspace.warnings.map((warning) => (
        <p className="ka-warning" key={warning}>
          {warning}
        </p>
      ))}
      {deepLinkWarning && <p className="ka-warning">{deepLinkWarning}</p>}
      <div className="ka-library-heading">
        <nav className="ka-tabs" aria-label="资产目录">
          <button
            aria-pressed={tab === 'owned'}
            onClick={() => {
              setTab('owned');
              setAssetType('all');
            }}
          >
            我方材料 <span>{saved.length}</span>
          </button>
          <button
            aria-pressed={tab === 'external'}
            onClick={() => {
              setTab('external');
              setAssetType('all');
            }}
          >
            外部来源
          </button>
          <button aria-pressed={tab === 'gaps'} onClick={() => setTab('gaps')}>
            待补材料 <span>{workspace.governance.length}</span>
          </button>
        </nav>
        <label className="ka-search">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSourceLimit(24);
            }}
            placeholder="查标题、问题或网址"
            aria-label="查找资产或材料缺口"
          />
          {query && (
            <button aria-label="清空查找" onClick={() => setQuery('')}>
              <X size={14} />
            </button>
          )}
        </label>
      </div>
      {tab !== 'gaps' && (
        <section className="ka-source-overview">
          <div className="ka-chart-heading">
            <h2>
              {sourceEngine === 'chatgpt' ? '回答引用来源' : '搜索结果来源'}
            </h2>
            <span>独立页面</span>
          </div>
          <dl className="ka-source-metrics">
            <div>
              <dt>全部来源页面</dt>
              <dd>{measured[sourceEngine] ? sourcesInScope.length : '未测'}</dd>
            </div>
            <div>
              <dt>我方页面</dt>
              <dd>{measured[sourceEngine] ? ownedInScope.length : '未测'}</dd>
            </div>
            <div>
              <dt>{hasUnknownOwnership ? '外部及待核实页面' : '外部页面'}</dt>
              <dd>
                {measured[sourceEngine] ? externalInScope.length : '未测'}
              </dd>
            </div>
          </dl>
          <div className="ka-source-charts">
            <SourceBars
              title="我方页面"
              items={owned}
              language={language}
              engine={sourceEngine}
              max={maxAnswers}
              measured={measured[sourceEngine]}
              onSelect={(item) => openItem(item, 'references', sourceEngine)}
            />
            <SourceBars
              title={hasUnknownOwnership ? '外部与待核实网站' : '外部网站'}
              items={external}
              language={language}
              engine={sourceEngine}
              max={maxAnswers}
              measured={measured[sourceEngine]}
              onSelect={(item) => openItem(item, 'references', sourceEngine)}
              onDomain={openDomain}
            />
          </div>
        </section>
      )}
      {tab !== 'gaps' ? (
        <>
          {tab === 'external' && (
            <div className="ka-source-scope">
              <nav className="ka-source-switch" aria-label="来源层级">
                <button
                  aria-pressed={sourceLevel === 'websites'}
                  onClick={() => {
                    setSourceLevel('websites');
                    setSourceDomain('');
                    setSourceLimit(24);
                  }}
                >
                  网站
                </button>
                <button
                  aria-pressed={sourceLevel === 'pages'}
                  onClick={() => {
                    setSourceLevel('pages');
                    setSourceDomain('');
                    setSourceLimit(24);
                  }}
                >
                  页面
                </button>
              </nav>
              <span className="ka-source-total">
                {measured[sourceEngine]
                  ? `${externalDomains.length} 个网站 · ${externalInScope.length} 个页面`
                  : '尚无观测'}
              </span>
              {sourceDomain && (
                <span className="ka-domain-breadcrumb">
                  <button
                    onClick={() => {
                      setSourceDomain('');
                      setSourceLevel('websites');
                    }}
                  >
                    全部网站
                  </button>
                  <ArrowRight size={12} />
                  <strong>{sourceDomain}</strong>
                </span>
              )}
            </div>
          )}
          {availableTypes.length > 1 && (
            <div className="ka-type-filter">
              <button
                aria-pressed={assetType === 'all'}
                onClick={() => setAssetType('all')}
              >
                全部
              </button>
              {availableTypes.map((type) => (
                <button
                  key={type}
                  aria-pressed={assetType === type}
                  onClick={() => setAssetType(type)}
                >
                  {typeNames[type] || type}
                </button>
              ))}
            </div>
          )}
          {tab === 'external' && sourceLevel === 'websites' ? (
            <section className="ka-library ka-domain-library">
              <div className="ka-domain-header">
                <span>来源网站</span>
                <span>页面</span>
                <span>
                  {sourceEngine === 'chatgpt' ? '涉及回答' : '来源条目'}
                </span>
                <span />
              </div>
              {visibleDomains.slice(0, sourceLimit).map((group, index) => (
                <button
                  className="ka-domain-row"
                  key={group.hostname}
                  onClick={() => openDomain(group.hostname)}
                >
                  <span>
                    <small>{index + 1}</small>
                    <strong>{group.hostname}</strong>
                  </span>
                  <span>{group.pages.length}</span>
                  <span>{group.count}</span>
                  <ArrowRight size={14} />
                  <i
                    style={{
                      width: `${(group.count / Math.max(1, externalDomains[0]?.count || 1)) * 100}%`,
                    }}
                  />
                </button>
              ))}
              {visibleDomains.length > sourceLimit && (
                <button
                  className="ka-load-more"
                  onClick={() => setSourceLimit((limit) => limit + 24)}
                >
                  再看 24 个网站
                </button>
              )}
              {!visibleDomains.length && (
                <p className="ka-empty">
                  {query
                    ? '没有符合查找条件的网站'
                    : measured[sourceEngine]
                      ? '本批没有外部来源'
                      : '尚无该入口观测'}
                </p>
              )}
            </section>
          ) : (
            <section className="ka-library">
              <div className="ka-list-header">
                <span>内容与来源</span>
                <span>关联问题</span>
                <span>
                  {sourceEngine === 'chatgpt' ? '回答引用' : '搜索结果'}
                </span>
              </div>
              {(tab === 'external'
                ? visible.slice(0, sourceLimit)
                : visible
              ).map(renderItem)}
              {tab === 'external' && visible.length > sourceLimit && (
                <button
                  className="ka-load-more"
                  onClick={() => setSourceLimit((limit) => limit + 24)}
                >
                  再看 24 个来源 · 还有 {visible.length - sourceLimit} 个
                </button>
              )}
              {!visible.length && (
                <p className="ka-empty">
                  {query || assetType !== 'all'
                    ? '没有符合筛选条件的材料'
                    : tab === 'owned'
                      ? '尚未收录内容'
                      : measured[sourceEngine]
                        ? '本批没有外部来源'
                        : '尚无该入口观测'}
                </p>
              )}
            </section>
          )}
          {tab === 'owned' && sourceLinks.length > 0 && (
            <details className="ka-source-only">
              <summary>
                <Link2 size={16} />
                正文待收录 <span>{sourceLinks.length}</span>{' '}
                <ArrowRight size={15} />
              </summary>
              <div className="ka-library">{sourceLinks.map(renderItem)}</div>
            </details>
          )}
        </>
      ) : (
        <>
          <div className="ka-gap-filters">
            <button
              aria-pressed={gapFilter === 'all'}
              onClick={() => setGapFilter('all')}
            >
              全部 <span>{workspace.governance.length}</span>
            </button>
            {(Object.keys(gapNames) as ContentGapCategory[]).map((category) => (
              <button
                key={category}
                aria-pressed={gapFilter === category}
                onClick={() => setGapFilter(category)}
              >
                {gapNames[category]}
                <span>
                  {
                    workspace.governance.filter(
                      (gap) => gap.category === category,
                    ).length
                  }
                </span>
              </button>
            ))}
          </div>
          <section className="ka-gap-list">
            <div className="ka-gap-header">
              <span>问题</span>
              <span>待补内容</span>
              <span>类型</span>
              <span>状态</span>
              <span />
            </div>
            {gaps.map((gap) => (
              <button
                className="ka-gap-row"
                key={gap.id}
                onClick={() => setSelection({ gap })}
              >
                <span className="ka-gap-question">
                  {gap.question[language]}
                </span>
                <span>
                  <strong>{gap.text}</strong>
                </span>
                <span className="ka-gap-kind">{gapNames[gap.category]}</span>
                <span className="ka-gap-status">
                  {
                    (
                      {
                        open: '待核查',
                        investigating: '核查中',
                        resolved: '已登记解决',
                      } as const
                    )[
                      data.governanceRecords?.find(
                        (record) =>
                          record.gapId === gap.id &&
                          record.batchId === gap.batchId,
                      )?.status || 'open'
                    ]
                  }
                </span>
                <ArrowUpRight size={16} />
              </button>
            ))}
            {!gaps.length && (
              <div className="ka-empty">
                <p>
                  {query
                    ? '没有符合查找条件的材料缺口'
                    : `当前审阅没有登记${gapFilter === 'all' ? '待补材料' : gapNames[gapFilter]}`}
                </p>
              </div>
            )}
          </section>
          {workspace.historicalGaps.length > 0 && (
            <details className="ka-legacy">
              <summary>
                历史缺口记录 · {workspace.historicalGaps.length}
              </summary>
              {workspace.historicalGaps.map(
                (gap: { id: string; title: string; description: string }) => (
                  <article key={gap.id}>
                    <h3>{gap.title}</h3>
                    <p>{gap.description}</p>
                  </article>
                ),
              )}
              <p>保留原记录；尚未按当前观测重新核定。</p>
            </details>
          )}
          <button className="ka-task-link" onClick={onTask}>
            查看已有改进任务 <ArrowRight size={15} />
          </button>
        </>
      )}
      <dialog
        ref={drawer}
        className="ka-drawer"
        aria-label="内容资产详情"
        onCancel={() => setSelection(null)}
        onClose={() => setSelection(null)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setSelection(null);
        }}
      >
        {selection && (
          <div className="ka-drawer-inner">
            <header className="ka-drawer-heading">
              <div>
                <small>
                  {data.project.name} · {languageName(language)}
                </small>
                <h2>
                  {'item' in selection
                    ? selection.item.title
                    : `${gapNames[selection.gap.category]}：${selection.gap.question[language]}`}
                </h2>
              </div>
              <button
                aria-label="关闭资产详情"
                onClick={() => setSelection(null)}
              >
                <X size={22} />
              </button>
            </header>
            <div className="ka-drawer-scroll">
              {'item' in selection ? (
                <ItemDetail
                  key={selection.item.id}
                  item={selection.item}
                  language={language}
                  detailTab={selection.detailTab}
                  referenceEngine={selection.sourceEngine}
                  selectedObservation={selection.observationIndex}
                  selectedQuestion={selection.observationQuestion}
                  onDetailChange={(detailTab, engine) =>
                    setSelection({
                      item: selection.item,
                      detailTab,
                      sourceEngine: engine,
                      observationIndex: selection.observationIndex,
                      observationQuestion: selection.observationQuestion,
                    })
                  }
                  measured={measured}
                  onAsset={(asset) => {
                    setSelection(null);
                    onAsset(asset);
                  }}
                />
              ) : (
                <GapDetail
                  key={selection.gap.id}
                  gap={selection.gap}
                  language={language}
                  engine={sourceEngine}
                  data={data}
                  onGovernance={onGovernance}
                  onImprove={
                    onImprove
                      ? (context) => {
                          setSelection(null);
                          onImprove(context);
                        }
                      : undefined
                  }
                  onOpenTask={
                    onOpenTask
                      ? (id) => {
                          setSelection(null);
                          onOpenTask(id);
                        }
                      : undefined
                  }
                />
              )}
            </div>
          </div>
        )}
      </dialog>
    </div>
  );
}

export default function ContentPanel(props: Props) {
  return <AssetWorkspace key={props.data.project.id} {...props} />;
}

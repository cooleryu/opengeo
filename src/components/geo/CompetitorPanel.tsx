'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, ArrowUpRight, Plus, Settings2, X } from 'lucide-react';
import type { GeoProject } from '@/lib/geo/types';
import type {
  CompetitorComparison,
  CompetitorMatch,
  CompetitorRow,
} from '@/lib/geo/competitor-types';
import type { ResearchEngine } from '@/lib/geo/research-types';
import {
  RESEARCH_ENGINES,
  RESEARCH_ENGINE_NAMES,
  isResearchEngine,
} from '@/lib/geo/research-engines';
import {
  isCompetitorAnswerRow,
  latestCompetitorRows,
} from '@/lib/geo/competitor-metrics';
import CompetitorCandidates from './CompetitorCandidates';
import GeoSelect from './GeoSelect';
import './competitor-panel.css';

function useComparison(projectId: string, batchId?: string) {
  const [data, setData] = useState<CompetitorComparison | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError('');
    let request = 0;
    function read() {
      const current = ++request;
      const params = new URLSearchParams({ project: projectId });
      if (batchId) params.set('batch', batchId);
      fetch(`/api/geo/competitor?${params}`, {
        signal: controller.signal,
      })
        .then(async (response) => {
          const value = await response.json();
          if (!response.ok)
            throw new Error(value.error || '对照记录读取失败。');
          if (
            value.projectId === projectId &&
            !controller.signal.aborted &&
            current === request
          ) {
            setData(value);
            setError('');
          }
        })
        .catch((cause) => {
          if (!controller.signal.aborted && current === request)
            setError(cause.message || '对照记录读取失败。');
        });
    }
    function changed(event: Event) {
      if (
        (event as CustomEvent<{ projectId?: string }>).detail?.projectId ===
        projectId
      )
        read();
    }
    read();
    window.addEventListener('geo-competitor-changed', changed);
    return () => {
      controller.abort();
      window.removeEventListener('geo-competitor-changed', changed);
    };
  }, [projectId, batchId]);
  return {
    data: data?.projectId === projectId ? data : null,
    setData,
    error,
    setError,
  };
}

export function CompetitorSummary({
  project,
  onOpen,
}: {
  project: GeoProject;
  onOpen?: () => void;
}) {
  const { data, error } = useComparison(project.id);
  return (
    <div className="cp-summary">
      <span>
        <strong>1:1 竞品</strong>
        {error ||
          (data
            ? data.target
              ? `已指定 ${data.target.name}`
              : '尚未指定对标对象'
            : '读取设置中…')}
      </span>
      {onOpen ? (
        <button type="button" onClick={onOpen}>
          {data?.target ? '查看对照' : '查看候选'}
          <ArrowRight size={14} />
        </button>
      ) : (
        <a href={`/?view=competitor&project=${encodeURIComponent(project.id)}`}>
          查看对照
          <ArrowRight size={14} />
        </a>
      )}
    </div>
  );
}

function Mention({ match }: { match: CompetitorMatch }) {
  return (
    <span className={`cp-status ${match.status}`}>
      {match.status === 'matched'
        ? '名称出现'
        : match.status === 'not_seen'
          ? '正文未见'
          : '未知'}
    </span>
  );
}

function SourceStatus({
  row,
  side,
}: {
  row: CompetitorRow;
  side: 'own' | 'target';
}) {
  const count = row.sources.filter((source) => source[side]).length;
  return (
    <span
      className={`cp-status ${count ? 'matched' : row.sourcesAvailable ? 'not_seen' : 'unknown'}`}
    >
      {count
        ? `${count} 个页面`
        : row.sourcesAvailable
          ? '已存来源未见'
          : '来源未保存'}
    </span>
  );
}

function targetFields(data: CompetitorComparison | null) {
  return {
    name: data?.target?.name || '',
    aliases: data?.target?.aliases.join('\n') || '',
    urls: data?.target?.officialUrls.join('\n') || '',
  };
}

function ComparisonWorkspace({ project }: { project: GeoProject }) {
  const [batchId, setBatchId] = useState<string | undefined>(undefined);
  const { data, setData, error, setError } = useComparison(project.id, batchId);
  const [editing, setEditing] = useState(false);
  const [fields, setFields] = useState(targetFields(null));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [language, setLanguage] = useState<'zh' | 'en'>('zh');
  const [engine, setEngine] = useState<ResearchEngine | 'all'>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<CompetitorRow | null>(null);
  const [returnPosition, setReturnPosition] = useState<{
    rowId: string;
    top: number;
  } | null>(null);
  const listPosition = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const readLocation = () => {
      const params = new URLSearchParams(window.location.search);
      setBatchId(params.get('batch') || undefined);
      setLanguage(params.get('language') === 'en' ? 'en' : 'zh');
      const requestedEngine = params.get('engine');
      setEngine(isResearchEngine(requestedEngine) ? requestedEngine : 'all');
      setSearch(params.get('search') || '');
      const rowId = params.get('compare');
      const top = Number(params.get('compareScroll') || 0);
      setReturnPosition(
        rowId
          ? { rowId, top: Number.isFinite(top) ? Math.max(0, top) : 0 }
          : null,
      );
    };
    readLocation();
    window.addEventListener('popstate', readLocation);
    return () => window.removeEventListener('popstate', readLocation);
  }, []);

  useEffect(() => {
    if (data) setFields(targetFields(data));
  }, [data]);
  useEffect(() => {
    if (!data || !returnPosition) return;
    const row = data.rows.find(
      (item) =>
        item.id === returnPosition.rowId &&
        item.language === language &&
        (engine === 'all' || item.engine === engine),
    );
    const frame = requestAnimationFrame(() => {
      listPosition.current = returnPosition.top;
      window.scrollTo({ top: returnPosition.top });
      setSelected(row || null);
      setReturnPosition(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [data, returnPosition, language, engine]);
  useEffect(() => {
    if (selected && !dialog.current?.open) dialog.current?.showModal();
    if (!selected && dialog.current?.open) dialog.current.close();
  }, [selected]);

  function openRow(row: CompetitorRow) {
    listPosition.current = window.scrollY;
    setSelected(row);
  }

  function closeRow() {
    setSelected(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('compare');
    url.searchParams.delete('compareScroll');
    window.history.replaceState(window.history.state, '', url);
  }

  function updateFilters(next: {
    language?: 'zh' | 'en';
    engine?: ResearchEngine | 'all';
    search?: string;
  }) {
    if (next.language) setLanguage(next.language);
    if (next.engine) setEngine(next.engine);
    if (next.search !== undefined) setSearch(next.search);
    setSelected(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('compare');
    url.searchParams.delete('compareScroll');
    url.searchParams.set('language', next.language || language);
    url.searchParams.set('engine', next.engine || engine);
    const nextSearch = next.search ?? search;
    if (nextSearch) url.searchParams.set('search', nextSearch);
    else url.searchParams.delete('search');
    window.history.replaceState(window.history.state, '', url);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/geo/competitor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          ...(batchId ? { batchId } : {}),
          target: {
            name: fields.name,
            aliases: fields.aliases
              .split(/\n/)
              .map((value) => value.trim())
              .filter(Boolean),
            officialUrls: fields.urls
              .split(/\n/)
              .map((value) => value.trim())
              .filter(Boolean),
          },
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '保存失败。');
      if (result.projectId !== project.id)
        throw new Error('返回的项目不匹配，请刷新重试。');
      setData(result);
      setEditing(false);
      setSelected(null);
      setMessage('对标设置已保存。');
      window.dispatchEvent(
        new CustomEvent('geo-competitor-changed', {
          detail: { projectId: project.id },
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败。');
    } finally {
      setSaving(false);
    }
  }

  function answerHref(row: CompetitorRow) {
    const returnTo =
      '/?' +
      new URLSearchParams({
        view: 'competitor',
        project: project.id,
        ...(batchId ? { batch: batchId } : {}),
        language,
        engine,
        ...(search ? { search } : {}),
        compare: row.id,
        compareScroll: String(listPosition.current),
      });
    return (
      '/?' +
      new URLSearchParams({
        view: 'questions',
        project: project.id,
        batch: data!.batch!.id,
        language: row.language,
        engine: row.engine,
        question: row.questionId,
        record: `${data!.batch!.id}:${row.questionId}:${row.engine}:${row.language}:${row.observationIndex}`,
        detail: 'answers',
        returnTo,
      })
    );
  }

  const scopedRows =
    data?.rows.filter(
      (row) =>
        row.language === language &&
        (engine === 'all' || row.engine === engine),
    ) || [];
  const metricRows = latestCompetitorRows(scopedRows);
  const rows = metricRows.filter(
    (row) =>
      !search.trim() ||
      row.question
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()),
  );
  const hasAnswerRows = scopedRows.some(isCompetitorAnswerRow);
  const target = data?.target;
  const showForm = !!data && editing;
  const engineOptions: { value: ResearchEngine | 'all'; label: string }[] = [
    { value: 'all', label: '全部平台' },
    ...RESEARCH_ENGINES.filter(
      (item) =>
        !target ||
        item === engine ||
        data?.rows.some((row) => row.engine === item),
    ).map((item) => ({ value: item, label: RESEARCH_ENGINE_NAMES[item] })),
  ];

  return (
    <section className="cp-page">
      <div className="cp-filters cp-analysis-filters">
        <GeoSelect
          label="分析语言"
          value={language}
          onChange={(value) => updateFilters({ language: value })}
          options={[
            { value: 'zh', label: '中文' },
            { value: 'en', label: 'English' },
          ]}
        />
        <GeoSelect
          label="分析平台"
          value={engine}
          onChange={(value) => updateFilters({ engine: value })}
          options={engineOptions}
        />
        <span className="cp-analysis-date">{data?.batch?.date}</span>
      </div>
      <CompetitorCandidates
        projectId={project.id}
        batchId={batchId}
        language={language}
        engine={engine}
        presentation="workspace"
      />
      <div className="cp-manual-entry">
        <button
          className="cp-button"
          type="button"
          onClick={() => {
            setEditing(!editing);
            setMessage('');
          }}
        >
          {target ? <Settings2 size={13} /> : <Plus size={13} />}
          {target ? '手动设置参照' : '已有明确对象？手动添加'}
        </button>
      </div>
      {error && (
        <p className="cp-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="cp-message" role="status">
          {message}
        </p>
      )}
      {!data && !error && <p className="cp-empty">正在读取对标设置…</p>}
      {showForm && (
        <form className="cp-config" onSubmit={save}>
          <div className="cp-section-heading">
            <h2>{target ? '手动设置参照' : '已有明确对象？手动添加'}</h2>
            {
              <button
                className="cp-button"
                type="button"
                onClick={() => {
                  setEditing(false);
                  setFields(targetFields(data));
                }}
              >
                取消
              </button>
            }
          </div>
          <div className="cp-config-fields">
            <label>
              <span>名称</span>
              <input
                required
                maxLength={120}
                value={fields.name}
                onChange={(event) =>
                  setFields({ ...fields, name: event.target.value })
                }
                autoComplete="off"
                placeholder="你希望对照的产品或品牌"
              />
            </label>
            <label>
              <span>
                别名 <small>选填，每行一个</small>
              </span>
              <textarea
                rows={3}
                value={fields.aliases}
                onChange={(event) =>
                  setFields({ ...fields, aliases: event.target.value })
                }
                placeholder="只填写属于该对象的名称"
              />
            </label>
            <label>
              <span>
                官方入口 <small>每行一个</small>
              </span>
              <textarea
                rows={3}
                required
                value={fields.urls}
                onChange={(event) =>
                  setFields({ ...fields, urls: event.target.value })
                }
                placeholder="https://example.com/product"
              />
            </label>
          </div>
          <div className="cp-config-footer">
            <p>按名称、别名和官方入口匹配已有记录。</p>
            <button
              className="cp-button primary"
              disabled={saving}
              type="submit"
            >
              {saving ? '保存中…' : '保存并查看对照'}
            </button>
          </div>
        </form>
      )}
      {target && data && (
        <details
          className="cp-record-details"
          open={!!returnPosition || !!selected}
        >
          <summary>
            查看逐题记录与来源依据 <ArrowRight size={13} />
          </summary>
          <div className="cp-toolbar">
            <div className="cp-pair">
              <strong>{data.own.name}</strong>
              <span>与</span>
              <strong>{target.name}</strong>
            </div>
          </div>
          <div className="cp-filters">
            <span className="cp-date">{data.batch?.date || '暂无批次'}</span>
            <GeoSelect
              label="对照语言"
              value={language}
              onChange={(value) => updateFilters({ language: value })}
              options={[
                { value: 'zh', label: '中文' },
                { value: 'en', label: 'English' },
              ]}
            />
            <GeoSelect
              label="对照入口"
              value={engine}
              onChange={(value) => updateFilters({ engine: value })}
              options={engineOptions}
            />
            <input
              aria-label="搜索对照问题"
              placeholder="搜索问题"
              value={search}
              onChange={(event) =>
                updateFilters({ search: event.target.value })
              }
            />
          </div>
          {rows.length ? (
            <>
              <div className="cp-section-heading">
                <h2>逐题对照</h2>
                <span>{rows.length} 条记录</span>
              </div>
              <div className="cp-table-wrap">
                <table className="cp-records">
                  <thead>
                    {hasAnswerRows ? (
                      <>
                        <tr>
                          <th rowSpan={2}>问题</th>
                          <th colSpan={2}>{data.own.name}</th>
                          <th colSpan={2}>{target.name}</th>
                          <th rowSpan={2}>
                            <span className="sr-only">详情</span>
                          </th>
                        </tr>
                        <tr>
                          <th>正文名称</th>
                          <th>官方来源</th>
                          <th>正文名称</th>
                          <th>官方来源</th>
                        </tr>
                      </>
                    ) : (
                      <tr>
                        <th>问题</th>
                        <th>{data.own.name} 官方网页</th>
                        <th>{target.name} 官方网页</th>
                        <th>
                          <span className="sr-only">详情</span>
                        </th>
                      </tr>
                    )}
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <button
                            type="button"
                            className="cp-question"
                            onClick={() => openRow(row)}
                          >
                            {row.question}
                          </button>
                        </td>
                        {hasAnswerRows && (
                          <td>
                            <Mention match={row.ownMention} />
                          </td>
                        )}
                        <td>
                          <SourceStatus row={row} side="own" />
                        </td>
                        {hasAnswerRows && (
                          <td>
                            <Mention match={row.targetMention} />
                          </td>
                        )}
                        <td>
                          <SourceStatus row={row} side="target" />
                        </td>
                        <td>
                          <button
                            type="button"
                            className="cp-detail-link"
                            onClick={() => openRow(row)}
                          >
                            依据
                            <ArrowRight size={13} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="cp-empty">
              <h3>{search ? '没有匹配的问题' : '当前条件下暂无可比记录'}</h3>
              <p>
                {search
                  ? '调整关键词后查看已有对照。'
                  : '双方仅使用相同问题、语言、入口与批次中的记录。'}
              </p>
            </div>
          )}
          <details className="cp-identities">
            <summary>名称与官方入口</summary>
            <div>
              {[data.own, target].map((identity, index) => (
                <section key={index}>
                  <h3>{identity.name}</h3>
                  <p>
                    {identity.aliases.length
                      ? `别名：${identity.aliases.join('、')}`
                      : '未配置别名'}
                  </p>
                  {identity.officialUrls.map((url) => (
                    <a key={url} href={url} target="_blank" rel="noreferrer">
                      {url}
                      <ArrowUpRight size={12} />
                    </a>
                  ))}
                </section>
              ))}
            </div>
          </details>
        </details>
      )}
      <dialog
        ref={dialog}
        className="cp-dialog"
        aria-labelledby="cp-detail-title"
        onCancel={closeRow}
        onClose={closeRow}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeRow();
        }}
      >
        {selected && data && target && (
          <article>
            <header>
              <div>
                <p>
                  {RESEARCH_ENGINE_NAMES[selected.engine]} ·{' '}
                  {selected.language === 'zh' ? '中文' : 'English'} ·{' '}
                  {data.batch?.date}
                </p>
                <h2 id="cp-detail-title">{selected.question}</h2>
              </div>
              <button
                className="cp-icon-button"
                type="button"
                aria-label="关闭对照依据"
                onClick={closeRow}
              >
                <X size={20} />
              </button>
            </header>
            <div className="cp-dialog-body">
              <div className="cp-section-heading">
                <h3>匹配依据</h3>
                <a className="cp-button" href={answerHref(selected)}>
                  查看原回答与来源
                  <ArrowRight size={14} />
                </a>
              </div>
              {isCompetitorAnswerRow(selected) && (
                <div className="cp-excerpts">
                  {(['own', 'target'] as const).map((side) => {
                    const match =
                      side === 'own'
                        ? selected.ownMention
                        : selected.targetMention;
                    return (
                      <section key={side}>
                        <h4>
                          {side === 'own' ? data.own.name : target.name}
                          <Mention match={match} />
                        </h4>
                        {match.names.length > 0 && (
                          <p>匹配名称：{match.names.join('、')}</p>
                        )}
                        {match.excerpts.map((excerpt, index) => (
                          <blockquote key={index}>{excerpt}</blockquote>
                        ))}
                        {match.status !== 'matched' && (
                          <p>
                            {match.status === 'unknown'
                              ? '正文未读取或无法识别，不能记为零提及。'
                              : '已读取的正文中没有匹配到配置名称。'}
                          </p>
                        )}
                      </section>
                    );
                  })}
                </div>
              )}
              <h3>
                {isCompetitorAnswerRow(selected)
                  ? '已保存的回答来源'
                  : '已保存的网页结果'}
              </h3>
              {selected.sources.length ? (
                <ul className="cp-sources">
                  {selected.sources.map((source, index) => (
                    <li key={`${source.url}:${index}`}>
                      <div>
                        <a href={source.url} target="_blank" rel="noreferrer">
                          {source.title}
                          <ArrowUpRight size={13} />
                        </a>
                        <span className="cp-source-tags">
                          {source.own && <span>我方官方入口</span>}
                          {source.target && <span>对标官方入口</span>}
                          {!source.own && !source.target && (
                            <span>其他来源</span>
                          )}
                        </span>
                      </div>
                      <small>{source.url}</small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="cp-boundary">
                  来源未保存，无法判断双方是否出现。
                </p>
              )}
              <details className="cp-conditions">
                <summary>观测条件与时间</summary>
                <p>{selected.conditions}</p>
                <p>{selected.recordedAt}</p>
                <p>实际问法：{selected.query}</p>
              </details>
            </div>
          </article>
        )}
      </dialog>
    </section>
  );
}

export default function CompetitorPanel({ project }: { project: GeoProject }) {
  return <ComparisonWorkspace key={project.id} project={project} />;
}

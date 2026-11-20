'use client';

import { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { identifyAiReferral } from '@/lib/geo/ai-referrals';
import type { TrafficSnapshot } from '@/lib/geo/traffic-types';
import ConversionPanel from './ConversionPanel';
import { useUiLanguage } from './UiLanguageContext';
import './traffic-panel.css';

type RequestState = {
  key: string;
  snapshot: TrafficSnapshot | null;
  error: string;
};

function recentRange(days: number) {
  const endDate = new Date().toISOString().slice(0, 10);
  const start = new Date(`${endDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { startDate: start.toISOString().slice(0, 10), endDate };
}

function TrafficWorkspace({ projectId }: { projectId: string }) {
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const locale = isEn ? 'en-US' : 'zh-CN';
  const numberFormat = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const timeFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        timeZone: 'UTC',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }),
    [locale],
  );
  const formatTime = (value: string | null | undefined) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : timeFormat.format(date);
  };

  const [days, setDays] = useState<7 | 30>(30);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<RequestState | null>(null);
  const range = useMemo(() => recentRange(days), [days, refresh]);
  const requestKey = `${projectId}:${days}:${refresh}`;
  const current = result?.key === requestKey ? result : null;
  const snapshot = current?.snapshot;
  const loading = current === null;
  const error =
    current?.error ||
    (snapshot?.status === 'error'
      ? snapshot.error?.message ||
        (isEn
          ? 'Could not load visitor stats. Refresh and try again.'
          : '访客统计暂时无法读取，请刷新重试。')
      : '');
  const measured = snapshot?.status === 'ready' || snapshot?.status === 'empty';
  const summary = measured ? snapshot.summary : null;
  const updatedAt = measured ? formatTime(snapshot.fetchedAt) : null;
  const displayedRange = snapshot?.range || range;

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ project: projectId, ...range });
    fetch(`/api/geo/traffic?${params}`, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            isEn
              ? 'Could not load visitor stats. Refresh and try again.'
              : '访客统计暂时无法读取，请刷新重试。',
          );
        }
        const value: TrafficSnapshot = await response.json();
        if (value.projectId !== projectId) {
          throw new Error(
            isEn
              ? 'Returned analytics data does not match the current project. Refresh and try again.'
              : '返回的统计数据与当前项目不符，请刷新重试。',
          );
        }
        if (!controller.signal.aborted)
          setResult({ key: requestKey, snapshot: value, error: '' });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setResult({
            key: requestKey,
            snapshot: null,
            error:
              cause instanceof Error &&
              (cause.message.includes('当前项目') ||
                cause.message.includes('current project'))
                ? cause.message
                : isEn
                  ? 'Could not load visitor stats. Refresh and try again.'
                  : '访客统计暂时无法读取，请刷新重试。',
          });
      });
    return () => controller.abort();
  }, [projectId, range, requestKey, isEn]);

  const stateMessage = loading
    ? isEn
      ? 'Loading visitor stats…'
      : '正在读取访客统计…'
    : error
      ? error
      : snapshot?.status === 'not_configured'
        ? isEn
          ? 'Umami is not connected for this project yet.'
          : '此项目尚未接入 Umami，暂无访客统计。'
        : snapshot?.status === 'empty'
          ? isEn
            ? 'No visits recorded in the selected period.'
            : '所选时段尚未记录到访问。'
          : '';
  const emptyMessage = loading
    ? isEn
      ? 'Loading…'
      : '读取中…'
    : error
      ? isEn
        ? 'Unavailable'
        : '暂时无法读取'
      : snapshot?.status === 'not_configured'
        ? isEn
          ? 'Not connected'
          : '尚未接入'
        : isEn
          ? 'No records'
          : '暂无记录';

  return (
    <section className="tp-page" aria-label={isEn ? 'Visitor traffic' : '访客统计'}>
      <header className="tp-toolbar">
        <h1>{isEn ? 'Visitor traffic' : '访客统计'}</h1>
        <div className="tp-actions">
          <div
            className="tp-periods"
            role="group"
            aria-label={isEn ? 'Date range' : '统计时段'}
          >
            {([7, 30] as const).map((period) => (
              <button
                key={period}
                type="button"
                aria-pressed={days === period}
                onClick={() => setDays(period)}
              >
                {isEn ? `Last ${period} days` : `近 ${period} 天`}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="tp-refresh"
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw size={14} aria-hidden="true" />
            {isEn ? 'Refresh' : '刷新'}
          </button>
        </div>
      </header>

      <div className="tp-meta">
        <span>
          {displayedRange.startDate} — {displayedRange.endDate}
          <span className="tp-timezone">UTC</span>
        </span>
        <span>
          Umami
          {updatedAt && (
            <>
              <span className="tp-meta-separator">·</span>
              {isEn ? 'Updated ' : '更新于 '}
              <time dateTime={snapshot?.fetchedAt || undefined}>
                {updatedAt}
              </time>
            </>
          )}
        </span>
      </div>

      <div className="tp-dashboard">
        <section
          className="tp-overview"
          aria-labelledby="tp-overview-heading"
          aria-busy={loading}
        >
          <h2 id="tp-overview-heading">
            {isEn ? 'Traffic overview' : '访问概况'}
          </h2>
          <dl className="tp-metrics">
            <div>
              <dt>
                {isEn ? 'Pageviews' : '访问次数'} <span>PV</span>
              </dt>
              <dd>{summary ? numberFormat.format(summary.pageviews) : '—'}</dd>
            </div>
            <div>
              <dt>
                {isEn ? 'Visitors' : '访客数'} <span>UV</span>
              </dt>
              <dd>{summary ? numberFormat.format(summary.visitors) : '—'}</dd>
            </div>
          </dl>

          {stateMessage && (
            <p
              className={`tp-state${error ? ' tp-error' : ''}`}
              role={error ? 'alert' : 'status'}
            >
              {stateMessage}
            </p>
          )}
        </section>

        <ConversionPanel
          projectId={projectId}
          range={range}
          requestKey={requestKey}
        />

        <div className="tp-tables">
          <section
            className="tp-table-section"
            aria-labelledby="tp-pages-heading"
          >
            <header>
              <h2 id="tp-pages-heading">{isEn ? 'Top pages' : '访问页面'}</h2>
              {measured && snapshot.pages.length >= snapshot.limit && (
                <span>
                  {isEn ? `Top ${snapshot.limit}` : `前 ${snapshot.limit} 项`}
                </span>
              )}
            </header>
            <div className="tp-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{isEn ? 'Page path' : '页面路径'}</th>
                    <th scope="col">{isEn ? 'Visitors' : '访客数'}</th>
                  </tr>
                </thead>
                <tbody>
                  {measured && snapshot.pages.length > 0 ? (
                    snapshot.pages.map((page) => (
                      <tr key={page.path}>
                        <td className="tp-path" data-i18n-skip="">
                          {page.path}
                        </td>
                        <td>{numberFormat.format(page.visitors)}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="tp-empty" colSpan={2}>
                        {emptyMessage}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
          <section
            className="tp-table-section"
            aria-labelledby="tp-referrers-heading"
          >
            <header>
              <h2 id="tp-referrers-heading">
                {isEn ? 'External referrers' : '外部来源'}
              </h2>
              {measured && snapshot.referrers.length >= snapshot.limit && (
                <span>
                  {isEn ? `Top ${snapshot.limit}` : `前 ${snapshot.limit} 项`}
                </span>
              )}
            </header>
            <div className="tp-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{isEn ? 'Referrer' : '来源'}</th>
                    <th scope="col">{isEn ? 'Visitors' : '访客数'}</th>
                  </tr>
                </thead>
                <tbody>
                  {measured && snapshot.referrers.length > 0 ? (
                    snapshot.referrers.map((source) => (
                      <tr key={source.referrer}>
                        <td>
                          <span data-i18n-skip="">
                            {source.referrer.trim() ||
                              (isEn ? 'Unknown source' : '未提供来源')}
                          </span>
                          {identifyAiReferral(source.referrer) && (
                            <span
                              className="tp-ai-referral"
                              title={
                                isEn
                                  ? 'Matched by referrer domain'
                                  : '根据来源域名识别'
                              }
                            >
                              {isEn ? 'AI referral' : 'AI 引荐'}
                            </span>
                          )}
                        </td>
                        <td>{numberFormat.format(source.visitors)}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="tp-empty" colSpan={2}>
                        {measured
                          ? isEn
                            ? 'No external referrers recorded'
                            : '未记录到外部来源'
                          : emptyMessage}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}

export default function TrafficPanel({ projectId }: { projectId: string }) {
  return <TrafficWorkspace key={projectId} projectId={projectId} />;
}

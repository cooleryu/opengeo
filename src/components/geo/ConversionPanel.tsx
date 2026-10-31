'use client';

import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { identifyAiReferral } from '@/lib/geo/ai-referrals';
import type { ConversionSnapshot } from '@/lib/geo/conversion-types';
import type { TrafficRange } from '@/lib/geo/traffic-types';
import './conversion-panel.css';

type RequestState = {
  key: string;
  snapshot: ConversionSnapshot | null;
  error: string;
};

type ConversionPanelProps = {
  projectId: string;
  range: Pick<TrafficRange, 'startDate' | 'endDate'>;
  requestKey: string;
};

const numberFormat = new Intl.NumberFormat('zh-CN');
const rateFormat = new Intl.NumberFormat('zh-CN', {
  style: 'percent',
  maximumFractionDigits: 1,
});
const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function formatRate(value: number | null | undefined) {
  return value == null ? '—' : rateFormat.format(value);
}

function sourceLabel(source: string) {
  if (!source || source === 'unknown') return '来源未提供';
  return source.startsWith('utm:') ? `UTM · ${source.slice(4)}` : source;
}

export default function ConversionPanel({
  projectId,
  range,
  requestKey,
}: ConversionPanelProps) {
  const [result, setResult] = useState<RequestState | null>(null);
  const current = result?.key === requestKey ? result : null;
  const snapshot = current?.snapshot;
  const loading = current === null;
  const error =
    current?.error ||
    (snapshot?.status === 'error'
      ? snapshot.error?.message || '转化统计暂时无法读取，请刷新重试。'
      : '');
  const measured = snapshot?.status === 'ready';
  const summary = measured ? snapshot.summary : null;
  const fetchedDate = snapshot?.fetchedAt ? new Date(snapshot.fetchedAt) : null;
  const updatedAt =
    fetchedDate && !Number.isNaN(fetchedDate.getTime())
      ? timeFormat.format(fetchedDate)
      : null;

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ project: projectId, ...range });
    fetch(`/api/geo/conversions?${params}`, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('转化统计暂时无法读取，请刷新重试。');
        const value: ConversionSnapshot = await response.json();
        if (value.projectId !== projectId)
          throw new Error('返回的转化数据与当前项目不符，请刷新重试。');
        if (!controller.signal.aborted)
          setResult({ key: requestKey, snapshot: value, error: '' });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setResult({
            key: requestKey,
            snapshot: null,
            error:
              cause instanceof Error && cause.message.includes('当前项目')
                ? cause.message
                : '转化统计暂时无法读取，请刷新重试。',
          });
      });
    return () => controller.abort();
  }, [projectId, range, requestKey]);

  const emptyMessage = loading
    ? '正在读取转化统计…'
    : error
      ? error
      : snapshot?.status === 'not_configured'
        ? '此项目尚未接入 Umami。'
        : snapshot?.status === 'unsupported'
          ? '此统计服务暂不支持文章漏斗。'
          : snapshot?.status === 'empty'
            ? '尚无文章事件'
            : '暂无可用的来源与落地页记录';

  return (
    <>
      <section
        className="tc-summary"
        aria-labelledby="tc-heading"
        aria-busy={loading}
      >
        <header className="tc-heading">
          <h2 id="tc-heading">文章转化</h2>
          <span>{snapshot?.windowMinutes || 30} 分钟内 · 访客数</span>
        </header>

        <div
          className="tc-funnel"
          aria-label="打开文章到点击 GitHub 的转化漏斗"
        >
          <dl className="tc-step">
            <dt>打开文章</dt>
            <dd>
              {summary ? numberFormat.format(summary.articleVisitors) : '—'}
            </dd>
          </dl>
          <ArrowRight className="tc-arrow" size={18} aria-hidden="true" />
          <dl className="tc-step">
            <dt>点击 GitHub</dt>
            <dd>
              {summary ? numberFormat.format(summary.githubVisitors) : '—'}
            </dd>
          </dl>
          <dl className="tc-rate">
            <dt>转化率</dt>
            <dd>{formatRate(summary?.conversionRate)}</dd>
          </dl>
        </div>
      </section>

      <section
        className="tc-section"
        aria-labelledby="tc-journeys-heading"
        aria-busy={loading}
      >
        <header className="tc-details-heading">
          <h2 id="tc-journeys-heading">来源与落地页</h2>
        </header>

        <div className="tc-table-wrap">
          <table aria-label="来源与落地页转化">
            <colgroup>
              <col className="tc-source-col" />
              <col className="tc-page-col" />
              <col className="tc-count-col" />
              <col className="tc-count-col" />
              <col className="tc-rate-col" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">来源</th>
                <th scope="col">落地页</th>
                <th scope="col">打开文章</th>
                <th scope="col">点击 GitHub</th>
                <th scope="col">转化率</th>
              </tr>
            </thead>
            <tbody>
              {measured && snapshot.journeys.length > 0 ? (
                snapshot.journeys.map((journey) => (
                  <tr
                    key={JSON.stringify([
                      journey.source,
                      journey.landingPage,
                      journey.entryScope,
                    ])}
                  >
                    <td>
                      {sourceLabel(journey.source)}
                      {!journey.source.startsWith('utm:') &&
                        identifyAiReferral(journey.source) && (
                          <span
                            className="tp-ai-referral"
                            title="根据来源域名识别"
                          >
                            AI 引荐
                          </span>
                        )}
                    </td>
                    <td>
                      <span className="tc-path">{journey.landingPage}</span>
                      {journey.entryScope === 'page' && (
                        <span
                          className="tc-page-scope"
                          title="浏览器存储不可用，仅记录当前页面的来源与路径，无法延续标签页入口。"
                        >
                          当前页
                        </span>
                      )}
                    </td>
                    <td>{numberFormat.format(journey.articleVisitors)}</td>
                    <td>{numberFormat.format(journey.githubVisitors)}</td>
                    <td>{formatRate(journey.conversionRate)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td
                    colSpan={5}
                    className={`tc-empty${error ? ' tc-error' : ''}`}
                  >
                    <span role={error ? 'alert' : 'status'}>
                      {emptyMessage}
                    </span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {measured &&
          (snapshot.grouping.truncated ||
            snapshot.grouping.invalidValues > 0) && (
            <p className="tc-coverage">
              {snapshot.grouping.truncated &&
                `按文章事件次数展示前 ${snapshot.limit} 组。`}
              {snapshot.grouping.invalidValues > 0 &&
                `另有 ${numberFormat.format(snapshot.grouping.invalidValues)} 组入口记录无法识别，未列入表格。`}
            </p>
          )}

        <details className="tc-definition">
          <summary>统计口径</summary>
          <div>
            <p>
              Umami 按月内匿名访客去重；点击 GitHub 仅统计先打开文章、再于 30
              分钟内点击的访客。转化率为这两步访客数之比，历史 PV
              不作分母。打开文章不代表读完，点击 GitHub 不代表安装。
            </p>
            <p>
              来源与落地页取浏览器标签页的入口，连续 30 分钟没有打开页面或点击
              GitHub 后重置；新的外部来源、有效 UTM
              或来源缺失也会重新记录入口。“当前页”表示浏览器存储不可用，只能记录当前页面。每行两步均匹配同一入口组合，同一访客可出现在多行，行数值不可相加。
            </p>
            <p>
              来源优先使用 已支持的 UTM
              标签，其次为外部来源域名；来源未提供不等于直接访问。表格按打开文章事件次数选取前{' '}
              {snapshot?.limit || 10} 组，不代表所有来源。
            </p>
            {updatedAt && (
              <p>
                转化更新于{' '}
                <time dateTime={snapshot?.fetchedAt || undefined}>
                  {updatedAt}
                </time>
                （北京时间）。
              </p>
            )}
          </div>
        </details>
      </section>
    </>
  );
}

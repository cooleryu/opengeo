'use client';

import { getResearchMetrics, type ResearchRow } from '@/lib/geo/research-view';
import {
  RESEARCH_ENGINES,
  RESEARCH_ENGINE_NAMES as names,
  RESEARCH_ENGINE_COLORS as colors,
} from '@/lib/geo/research-engines';

export default function ResearchChart({
  rows,
  date,
  compact = false,
  byPlatform = false,
  onOpen,
}: {
  rows: ResearchRow[];
  date: string;
  compact?: boolean;
  byPlatform?: boolean;
  onOpen: (engine: ResearchRow['engine']) => void;
}) {
  const entries = RESEARCH_ENGINES.filter((engine) =>
    rows.some((row) => row.engine === engine),
  ).map((engine) => ({
    engine,
    stats: getResearchMetrics(rows.filter((row) => row.engine === engine)),
  }));
  if (!byPlatform)
    return (
      <section
        className={
          'rw-chart-panel rw-composition' + (compact ? ' compact' : '')
        }
        aria-label="最新记录的官方来源分布"
      >
        <header className="rw-section-heading">
          <h2>官方来源分布</h2>
          <span>各题最新记录</span>
        </header>
        <div className="rw-composition-grid">
          {entries.map(({ engine, stats }) => (
            <button
              className="rw-composition-entry"
              key={engine}
              onClick={() => onOpen(engine)}
              aria-label={`${names[engine]}：${stats.found}/${stats.completed} 条找到官方来源，查看记录`}
            >
              <span className="rw-composition-ring">
                <svg viewBox="0 0 120 120" aria-hidden="true">
                  <circle
                    cx="60"
                    cy="60"
                    r="46"
                    fill="none"
                    stroke="#eceef0"
                    strokeWidth="10"
                  />
                  <circle
                    cx="60"
                    cy="60"
                    r="46"
                    fill="none"
                    stroke={colors[engine]}
                    strokeWidth="10"
                    strokeDasharray={`${(stats.rate ?? 0) * 2.8903} 289.03`}
                    transform="rotate(-90 60 60)"
                  />
                </svg>
                <strong>
                  {stats.rate === null
                    ? '—'
                    : `${Number(stats.rate.toFixed(1))}%`}
                </strong>
              </span>
              <span className="rw-composition-values">
                <b>{names[engine]}</b>
                <span>
                  <i style={{ background: colors[engine] }} />
                  找到官方来源<strong>{stats.found}</strong>
                </span>
                <span>
                  <i />
                  本次未见<strong>{stats.completed - stats.found}</strong>
                </span>
                {stats.unmeasured > 0 && (
                  <span>
                    未测<strong>{stats.unmeasured}</strong>
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      </section>
    );
  return (
    <section
      className={'rw-chart-panel' + (compact ? ' compact' : '')}
      aria-label="官方来源发现率图表"
    >
      <header className="rw-section-heading">
        <h2>{byPlatform ? '按入口划分的发现率' : '官方来源发现率'}</h2>
        <span>各题最新记录</span>
      </header>
      <svg
        viewBox="0 0 500 245"
        role="img"
        aria-label={entries
          .map(
            ({ engine, stats }) =>
              names[engine] +
              ' ' +
              (stats.rate === null
                ? '未测'
                : Number(stats.rate.toFixed(1)) + '%'),
          )
          .join('，')}
      >
        {[0, 25, 50, 75, 100].map((value) => (
          <g key={value}>
            <line
              x1="43"
              x2="476"
              y1={204 - value * 1.7}
              y2={204 - value * 1.7}
              stroke="#e6e7e9"
              strokeDasharray="3 4"
            />
            <text
              x="33"
              y={208 - value * 1.7}
              textAnchor="end"
              fill="#85888d"
              fontSize="11"
            >
              {value}%
            </text>
          </g>
        ))}
        {entries.map(({ engine, stats }, index) =>
          stats.rate === null ? null : (
            <g key={engine}>
              {byPlatform ? (
                <rect
                  x={43 + (index + 0.5) * (433 / entries.length) - 22}
                  y={204 - stats.rate * 1.7}
                  width="44"
                  height={stats.rate * 1.7}
                  rx="3"
                  fill={colors[engine]}
                >
                  <title>
                    {names[engine]}：{stats.found}/{stats.completed}
                  </title>
                </rect>
              ) : (
                <circle
                  cx={entries.length === 1 ? 260 : 244 + index * 32}
                  cy={204 - stats.rate * 1.7}
                  r="5"
                  fill={colors[engine]}
                >
                  <title>
                    {names[engine]}：{stats.found}/{stats.completed}
                  </title>
                </circle>
              )}
              <text
                x={
                  byPlatform
                    ? 43 + (index + 0.5) * (433 / entries.length)
                    : entries.length === 1
                      ? 260
                      : 238 + index * 44
                }
                y={189 - stats.rate * 1.7}
                textAnchor={
                  byPlatform
                    ? 'middle'
                    : index === 0 && entries.length > 1
                      ? 'end'
                      : 'start'
                }
                fill={colors[engine]}
                fontSize="12"
              >
                {Number(stats.rate.toFixed(1))}%
              </text>
            </g>
          ),
        )}
        {byPlatform ? (
          entries.map(({ engine }, index) => (
            <text
              key={engine}
              x={43 + (index + 0.5) * (433 / entries.length)}
              y="232"
              textAnchor="middle"
              fill="#85888d"
              fontSize="11"
            >
              {names[engine]}
            </text>
          ))
        ) : (
          <text
            x="260"
            y="232"
            textAnchor="middle"
            fill="#85888d"
            fontSize="11"
          >
            {date}
          </text>
        )}
      </svg>
      <div className="rw-chart-legend">
        {entries.map(({ engine, stats }) => (
          <button key={engine} onClick={() => onOpen(engine)}>
            <i style={{ background: colors[engine] }} />
            {names[engine]}
            <span>
              {stats.found}/{stats.completed}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

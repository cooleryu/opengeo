'use client';

import { useState } from 'react';
import type { GeoAsset, GeoState } from '@/lib/geo/types';

type ContentGroup = { id: string; assetIds: string[] };
type Topic = {
  id: string;
  title: string;
  question: string;
  purpose: string;
  groups: ContentGroup[];
};

const topics: Topic[] = [
  {
    id: '258k',
    title: '258K 显示与配置',
    question: 'Codex 为什么还是显示 258K？',
    purpose: '帮助用户核对模型、配置和会话，让 500K 默认窗口生效。',
    groups: [
      {
        id: '258k-guide',
        assetIds: ['codex-258k-context-zh-CN', 'codex-258k-context-en'],
      },
    ],
  },
  {
    id: '500k',
    title: '500K 默认窗口',
    question: '窗口变大以后，该怎么用？',
    purpose: '解释默认窗口、自动压缩，以及执行前仍然需要核对的依据。',
    groups: [
      {
        id: '500k-article',
        assetIds: ['codex-500k-context-zh-CN', 'codex-500k-context-en'],
      },
    ],
  },
  {
    id: 'context',
    title: '上下文长度与评估',
    question: 'Agent 到底需要多少上下文？',
    purpose: '从选择材料到测量代码证据保留，提供指南和研究记录。',
    groups: [
      {
        id: 'length-guide',
        assetIds: ['context-length-guide-zh-CN', 'context-length-guide-en'],
      },
      { id: 'context-study', assetIds: ['code-context-study'] },
    ],
  },
  {
    id: 'reliability',
    title: '长期任务可靠性',
    question: '计划没变，为什么行动会出错？',
    purpose: '讨论目标、文件与权限变化，如何让原本合理的计划过期。',
    groups: [
      {
        id: 'valid-plan',
        assetIds: ['the-plan-was-valid-zh-CN', 'the-plan-was-valid-en'],
      },
    ],
  },
];

function languageLabel(language: string) {
  return language.startsWith('zh')
    ? '中文'
    : language === 'en'
      ? '英文'
      : language;
}

export default function ContentPanel({
  data,
  onAsset,
  onTask,
}: {
  data: GeoState;
  onAsset: (asset: GeoAsset) => void;
  onTask: () => void;
}) {
  const [selectedId, setSelectedId] = useState(topics[0].id);
  const availableTopics = topics.filter((topic) =>
    topic.groups.some((group) =>
      group.assetIds.some((id) => data.assets.some((asset) => asset.id === id)),
    ),
  );
  const selected =
    availableTopics.find((topic) => topic.id === selectedId) ||
    availableTopics[0];
  const contentCount = availableTopics.reduce(
    (total, topic) =>
      total +
      topic.groups.filter((group) =>
        group.assetIds.some((id) =>
          data.assets.some((asset) => asset.id === id),
        ),
      ).length,
    0,
  );
  const selectedIds = new Set(
    selected?.groups.flatMap((group) => group.assetIds) || [],
  );
  const questions = data.questions.filter((question) =>
    question.matchingAssetIds?.some((id) => selectedIds.has(id)),
  );
  const questionHits = questions.filter(
    (question) => question.projectHit,
  ).length;
  const homepage = data.assets.find((asset) => asset.id === 'site-home');
  const social = data.assets.filter((asset) =>
    asset.type.startsWith('social_'),
  );
  function renderContentGroup(group: ContentGroup, index: number) {
    const assets = group.assetIds.flatMap((id) => {
      const asset = data.assets.find((item) => item.id === id);
      return asset ? [asset] : [];
    });
    if (!assets.length) return null;
    const primary = assets[0];
    return (
      <article className="og-content-row" key={group.id}>
        <div className="og-content-row-text">
          <span className="og-eyebrow">
            {primary.type === 'guide'
              ? '实用指南'
              : primary.type === 'research'
                ? '研究记录'
                : '文章'}
            {primary.publishedAt
              ? ` · ${primary.publishedAt.slice(0, 10)}`
              : ''}
          </span>
          <h3>{primary.title}</h3>
          <p>{primary.summary}</p>
        </div>
        <div className="og-content-languages">
          {assets.map((asset, assetIndex) => (
            <button
              className={`og-button ${index === 0 && assetIndex === 0 ? 'primary' : 'secondary'}`}
              key={asset.id}
              onClick={() => onAsset(asset)}
            >
              阅读{languageLabel(asset.language)}{' '}
              <span aria-hidden="true">↗</span>
            </button>
          ))}
        </div>
      </article>
    );
  }

  return (
    <div className="og-content-page">
      <header className="og-page-heading">
        <div>
          <span className="og-eyebrow">内容库</span>
          <h1>已有内容</h1>
          <p>
            {contentCount} 篇文章与指南，围绕 {availableTopics.length}{' '}
            类用户问题。中英文版本放在一起。
          </p>
        </div>
      </header>

      <div className="og-content-layout">
        <nav className="og-topic-nav" aria-label="按用户问题浏览内容">
          <span className="og-eyebrow">内容主题</span>
          {availableTopics.map((topic, index) => (
            <button
              key={topic.id}
              className={selected?.id === topic.id ? 'active' : ''}
              aria-pressed={selected?.id === topic.id}
              onClick={() => setSelectedId(topic.id)}
            >
              <span className="og-topic-number">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span>
                <strong>{topic.title}</strong>
                <small>
                  {
                    topic.groups.filter((group) =>
                      group.assetIds.some((id) =>
                        data.assets.some((asset) => asset.id === id),
                      ),
                    ).length
                  }{' '}
                  篇内容
                </small>
              </span>
              <span aria-hidden="true">→</span>
            </button>
          ))}
        </nav>

        {selected && (
          <section
            className="og-topic-detail og-surface"
            aria-label={selected.title}
          >
            <div className="og-topic-intro">
              <span className="og-eyebrow">回答这个问题</span>
              <h2>{selected.question}</h2>
              <p>{selected.purpose}</p>
            </div>
            <div className="og-content-rows">
              {selected.groups.map(renderContentGroup)}
            </div>
            <div className="og-content-coverage">
              <div className="og-content-coverage-heading">
                <h3>对应的搜索问题</h3>
                <span className={`og-tag ${questionHits ? 'blue' : 'neutral'}`}>
                  {questions.length
                    ? `${questionHits} / ${questions.length} 找到项目`
                    : '尚未设置观察问题'}
                </span>
              </div>
              {questions.length ? (
                <ul>
                  {questions
                    .filter((question) => question.language.startsWith('zh'))
                    .map((question) => (
                      <li key={question.id}>
                        <span>{question.query}</span>
                        <small>
                          {question.projectHit ? '找到项目' : '未找到项目'}
                        </small>
                      </li>
                    ))}
                </ul>
              ) : (
                <p className="og-muted">
                  目前题单还没有覆盖这个主题，不能据此判断可见性。
                </p>
              )}
              {questions.length > 0 && (
                <p className="og-muted">
                  {questions.some((question) => question.language === 'en')
                    ? '包含中英文提问。'
                    : ''}
                  关联表示已有相关材料；搜索命中按项目统计，不代表这篇内容已被引用。
                </p>
              )}
            </div>
          </section>
        )}
      </div>

      <div className="og-content-secondary">
        <details className="og-content-fold">
          <summary>
            <span>
              <strong>项目首页与传播</strong>
              <small>
                首页 {homepage ? '1' : '0'} 个 · X 发布 {social.length} 条
              </small>
            </span>
            <span aria-hidden="true">＋</span>
          </summary>
          <div className="og-content-supporting">
            {homepage && (
              <div>
                <span className="og-eyebrow">项目首页</span>
                <button
                  className="og-content-link"
                  onClick={() => onAsset(homepage)}
                >
                  {homepage.title} <span aria-hidden="true">↗</span>
                </button>
                <p>{homepage.summary}</p>
              </div>
            )}
            {social.length > 0 && (
              <div>
                <span className="og-eyebrow">传播记录</span>
                {social.map((asset) => (
                  <button
                    className="og-content-link"
                    key={asset.id}
                    onClick={() => onAsset(asset)}
                  >
                    <span>
                      {asset.type === 'social_article' ? 'X 文章' : 'X 转发'} ·{' '}
                      {asset.title}
                    </span>
                    <span aria-hidden="true">↗</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </details>
        <details className="og-content-fold">
          <summary>
            <span>
              <strong>接下来需要补什么</strong>
              <small>首页表达，以及改进后的验证</small>
            </span>
            <span aria-hidden="true">＋</span>
          </summary>
          <div className="og-content-gaps">
            {data.gaps.map(
              (gap: { id: string; title: string; description: string }) => (
                <div key={gap.id}>
                  <strong>{gap.title}</strong>
                  <p>{gap.description}</p>
                </div>
              ),
            )}
            <button className="og-content-link" onClick={onTask}>
              查看当前改进任务 <span aria-hidden="true">→</span>
            </button>
          </div>
        </details>
      </div>
    </div>
  );
}

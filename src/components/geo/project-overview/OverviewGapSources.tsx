'use client';

import { ArrowRight, ExternalLink, GitPullRequest, MessageSquarePlus } from 'lucide-react';
import type { ResearchEngine, ResearchQuestion } from '@/lib/geo/research-types';
import type { OverviewGapSource, OverviewGapSourceKind } from '@/lib/geo/research-view';
import ResearchEngineIcon from '../ResearchEngineIcon';
import { useUiLanguage } from '../UiLanguageContext';
import { getPlatformName } from './overview-format';

type OverviewGapSourcesProps = {
  onPlan: ((question?: ResearchQuestion, language?: 'zh' | 'en', engine?: ResearchEngine) => Promise<void> | void) | undefined;
  overviewGapSources: OverviewGapSource[];
};

export function OverviewGapSources({
  onPlan,
  overviewGapSources,
}: OverviewGapSourcesProps) {
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const gapKindLabel = (kind: OverviewGapSourceKind): string => {
    if (kind === 'awesome') return isEn ? 'Open-source directory' : '开源导航清单';
    if (kind === 'community') return isEn ? 'Community' : '社区讨论';
    if (kind === 'roundup') return isEn ? 'Listicle' : '横评指南';
    return isEn ? 'Competitor' : '竞品来源';
  };

  return (
    <section
      className="pov-gap-card"
      aria-labelledby="pov-gap-heading"
    >
      <div className="pov-section-bar">
        <div className="pov-section-title pov-gap-title-wrap">
          <h2 id="pov-gap-heading">
            {isEn
              ? 'External pages AI cites without you'
              : 'AI 引用但尚未收录你的外部页面'}
          </h2>
          <span className="pov-gap-sub">
            {isEn
              ? 'Already cited by AI answers — submit a listing PR to open-source directories or join cited discussions'
              : '这些外部清单与讨论帖已被 AI 回答直接引用——可向开源导航清单提 PR 申请收录，或参与社区讨论'}
          </span>
        </div>
        <div className="pov-section-tools">
          <button
            type="button"
            className="pov-inline-link"
            onClick={() => void onPlan?.()}
          >
            {isEn ? 'Open Action Plan' : '查看行动计划'} <ArrowRight size={13} />
          </button>
        </div>
      </div>

      <div
        className="pov-gap-table-wrap"
        tabIndex={0}
        role="region"
        aria-labelledby="pov-gap-heading"
      >
        <table
          className="pov-gap-table"
          style={
            {
              '--col-type': JSON.stringify(isEn ? 'Type' : '类型'),
              '--col-engines': JSON.stringify(isEn ? 'Engines' : '引用平台'),
              '--col-prompts': JSON.stringify(isEn ? 'Prompts' : '出现题数'),
              '--col-action': JSON.stringify(isEn ? 'Next move' : '推荐动作'),
            } as React.CSSProperties
          }
        >
          <thead>
            <tr>
              <th scope="col">{isEn ? 'Source URL / Repo' : '页面 / 仓库'}</th>
              <th scope="col">{isEn ? 'Type' : '类型'}</th>
              <th scope="col">{isEn ? 'Engines' : '引用平台'}</th>
              <th scope="col" className="is-num">
                {isEn ? 'Prompts' : '出现题数'}
              </th>
              <th scope="col" className="is-action">
                {isEn ? 'Next move' : '推荐动作'}
              </th>
            </tr>
          </thead>
          <tbody>
            {overviewGapSources.map((src) => (
              <tr key={src.key}>
                <th scope="row">
                  <a
                    href={src.url}
                    target="_blank"
                    rel="noreferrer"
                    className="pov-gap-source-link"
                  >
                    <strong data-i18n-skip="">{src.title}</strong>
                    <span data-i18n-skip={src.subtitle === 'web' ? undefined : ''}>
                      {src.subtitle === 'web'
                        ? isEn
                          ? 'Cited web page'
                          : 'AI 引用网页'
                        : src.subtitle}
                    </span>
                  </a>
                </th>
                <td>
                  <span className={`pov-gap-badge is-${src.kind}`}>
                    {gapKindLabel(src.kind)}
                  </span>
                </td>
                <td>
                  <div className="pov-gap-engines">
                    {src.engines.map((eng) => (
                      <span
                        key={eng}
                        className="pov-gap-engine-dot"
                        title={getPlatformName(eng, isEn)}
                      >
                        <ResearchEngineIcon engine={eng} />
                      </span>
                    ))}
                  </div>
                </td>
                <td className="is-num">
                  <span className="pov-gap-count">
                    {src.questionCount}
                    {isEn ? 'q' : ' 题'}
                  </span>
                </td>
                <td className="is-action">
                  {src.actionHint === 'submit_pr' ? (
                    <button
                      type="button"
                      className="pov-gap-action-btn is-primary"
                      onClick={() => void onPlan?.()}
                    >
                      <GitPullRequest size={12} />
                      <span>{isEn ? 'Submit listing PR' : '提 PR 申请收录'}</span>
                    </button>
                  ) : src.actionHint === 'community_draft' ? (
                    <button
                      type="button"
                      className="pov-gap-action-btn"
                      onClick={() => void onPlan?.()}
                    >
                      <MessageSquarePlus size={12} />
                      <span>{isEn ? 'Draft note' : '去发声'}</span>
                    </button>
                  ) : (
                    <a
                      href={src.url}
                      target="_blank"
                      rel="noreferrer"
                      className="pov-gap-action-btn"
                    >
                      <span>{isEn ? 'Inspect' : '查看'}</span>
                      <ExternalLink size={11} />
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

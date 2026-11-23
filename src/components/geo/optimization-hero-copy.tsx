import type { ReactNode } from 'react';
import {
  getExternalListingType,
  type ExternalListingType,
} from '@/lib/geo/outreach/external-page-meta';

export interface HeroNextOutreach {
  id: string;
  kind: 'awesome_pr' | 'repo_meta' | 'directory_listing' | 'community_post';
  title: string;
  citedCount: number;
  targetUrl: string;
  listingType?: ExternalListingType;
}

function resolveListingType(next: HeroNextOutreach): ExternalListingType {
  return (
    next.listingType ??
    getExternalListingType({ url: next.targetUrl, title: next.title })
  );
}

export function formatNextOutreachCta(
  next: HeroNextOutreach | null,
  isEn: boolean,
): ReactNode {
  if (!next) return isEn ? 'Open Action Plan' : '查看行动计划';
  if (next.kind === 'awesome_pr') {
    return isEn ? (
      <>
        Next: Submit PR to <span data-i18n-skip="">{next.title}</span>
      </>
    ) : (
      <>
        下一步：向 <span data-i18n-skip="">{next.title}</span> 提榜单 PR
      </>
    );
  }
  if (next.kind === 'repo_meta') {
    return isEn
      ? 'Next: Sync GitHub About & Topics'
      : '下一步：补齐 GitHub 仓库简介与标签';
  }
  if (next.kind === 'directory_listing') {
    const listingType = resolveListingType(next);
    if (listingType === 'editorial_roundup') {
      return isEn
        ? 'Next: Pitch AI-cited comparison articles'
        : '下一步：查看测评文章与作者自荐信';
    }
    return isEn ? (
      <>
        Next: Submit to <span data-i18n-skip="">{next.title}</span>
      </>
    ) : (
      <>
        下一步：向「<span data-i18n-skip="">{next.title}</span>」提交收录
      </>
    );
  }
  if (next.id.startsWith('post:thread:')) {
    return isEn ? 'Next: Reply in AI-cited discussion' : '下一步：去高引用社区帖补充回复';
  }
  return isEn ? (
    <>
      Next: Share on <span data-i18n-skip="">{next.title}</span>
    </>
  ) : (
    <>
      下一步：查看「<span data-i18n-skip="">{next.title}</span>」发布草稿
    </>
  );
}

export function formatNextOutreachHeadline(
  next: HeroNextOutreach,
  stage: 'awaiting' | 'indexing' | 'post_window',
  isEn: boolean,
): ReactNode {
  const titleNode = <span data-i18n-skip="">{next.title}</span>;
  const prefix = isEn
    ? stage === 'awaiting'
      ? 'Docs are live'
      : stage === 'indexing'
        ? 'Recent updates are still indexing'
        : 'No lift yet'
    : stage === 'awaiting'
      ? '内容已上线'
      : stage === 'indexing'
        ? '最近上线的内容还在收录期内'
        : '暂未新增提及';

  if (next.kind === 'awesome_pr') {
    return isEn ? (
      stage === 'awaiting' ? (
        <>Docs are live — next, submit your PR to {titleNode}</>
      ) : stage === 'indexing' ? (
        <>Recent updates are still indexing — next, submit a PR to {titleNode}</>
      ) : (
        <>No lift yet — next, submit your PR to {titleNode}</>
      )
    ) : stage === 'awaiting' ? (
      <>内容已上线，趁收录期间先提交「{titleNode}」榜单 PR</>
    ) : stage === 'indexing' ? (
      <>最近上线的内容还在收录期内；这期间先去提交「{titleNode}」PR</>
    ) : (
      <>暂未新增提及；下一步先提「{titleNode}」榜单 PR</>
    );
  }

  if (next.kind === 'repo_meta') {
    return isEn
      ? `${prefix} — next, sync your GitHub repo description & topics`
      : `${prefix}；下一步先补齐 GitHub 仓库简介与标签`;
  }

  if (next.kind === 'directory_listing') {
    const listingType = resolveListingType(next);
    if (listingType === 'editorial_roundup') {
      return isEn ? (
        <>{prefix} — next, pitch AI-cited article &ldquo;{titleNode}&rdquo;</>
      ) : (
        <>{prefix}；下一步可联系 AI 引用的测评文章「{titleNode}」作者申请补充收录</>
      );
    }
    return isEn ? (
      <>{prefix} — next, submit your product to {titleNode}</>
    ) : (
      <>{prefix}；下一步可向软件目录「{titleNode}」提交产品收录</>
    );
  }

  if (next.id.startsWith('post:thread:')) {
    return isEn ? (
      <>{prefix} — next, join AI-cited thread &ldquo;{titleNode}&rdquo;</>
    ) : (
      <>{prefix}；下一步可在 AI 引用的真实求助帖「{titleNode}」补充经验回复</>
    );
  }

  return isEn ? (
    <>{prefix} — next, prepare launch post on {titleNode}</>
  ) : (
    <>{prefix}；下一步可准备「{titleNode}」发布帖</>
  );
}

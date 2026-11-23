import type { DirectoryListingDraft, OutreachActionRecord } from './outreach-store';

export type ExternalListingType = 'directory' | 'editorial_roundup';

export const COMMUNITY_FORUM_HOST_RE =
  /(?:^|\.)(?:reddit\.com|news\.ycombinator\.com|quora\.com|stackoverflow\.com|stackexchange\.com|indiehackers\.com|v2ex\.com|zhihu\.com|dev\.to|medium\.com|substack\.com|youtube\.com|youtu\.be|x\.com|twitter\.com|linkedin\.com)$/i;

export const COMMUNITY_FORUM_URL_RE =
  /(?:^https?:\/\/(?:users|community|discuss|forum)\.|\/(?:t|discussions|forum|forums|comments)\/)/i;

export const KNOWN_DIRECTORY_HOST_RE =
  /(?:^|\.)(?:g2\.com|capterra\.com|getapp\.com|trustradius\.com|producthunt\.com|alternativeto\.net|sourceforge\.net|saasworthy\.com|softwaresuggest\.com|glama\.ai|smithery\.ai|mcp\.so|pulsemcp\.com|marketmcp\.vercel\.app|theresanaiforthat\.com|futurepedia\.io|toolify\.ai|aitoolsdirectory\.com|openalternative\.co|selfh\.st|libhunt\.com|stackshare\.io|slant\.co|crozdesk\.com|softwareadvice\.com|betalist\.com|saashub\.com|toolpilot\.ai|topai\.tools)$/i;

const SELF_SERVE_DIRECTORY_PATH_RE =
  /(?:^|\/)(?:directory|catalog|marketplace|categories|mcp\/best|listings|submit)(?:\/|$)/i;

const EDITORIAL_ROUNDUP_RE =
  /(?:\/(?:best|top|alternatives|compare|comparison|guides|blog|articles|tools)\b|\b(?:best|top\s+\d+|alternatives?|compared|comparison|roundup|directory|catalog|marketplace|open[- ]source\s+\w+\s+list)\b)/i;

const ACRONYM_MAP: Record<string, string> = {
  ai: 'AI',
  geo: 'GEO',
  aeo: 'AEO',
  seo: 'SEO',
  llm: 'LLM',
  llms: 'LLMs',
  api: 'API',
  mcp: 'MCP',
  cli: 'CLI',
  pr: 'PR',
  saas: 'SaaS',
  chatgpt: 'ChatGPT',
  github: 'GitHub',
  opengeo: 'OpenGEO',
  url: 'URL',
  urls: 'URLs',
  b2b: 'B2B',
  ui: 'UI',
  ux: 'UX',
};

const LOWERCASE_SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'with',
]);

export function extractCleanHost(url: string, fallbackHost?: string): string {
  const fromFallback = (fallbackHost || '').trim().toLowerCase().replace(/^www\./, '');
  if (fromFallback) return fromFallback;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function isCommunityForumPage(page: {
  url: string;
  title?: string;
  host?: string;
}): boolean {
  const host = extractCleanHost(page.url, page.host);
  if (COMMUNITY_FORUM_HOST_RE.test(host)) return true;
  if (COMMUNITY_FORUM_URL_RE.test(page.url)) return true;
  if (/\breddit\b|(?:^|[\s·/])r\/[a-z0-9_]+|hacker news/i.test(page.title ?? '')) {
    return true;
  }
  return false;
}

/**
 * True ONLY for genuine self-serve software/tool directories & marketplaces
 * (e.g. G2, AlternativeTo, OpenAlternative, Product Hunt, Glama, /directory),
 * NOT independent blog posts or editorial comparison guides.
 */
export function isSelfServeDirectoryPage(page: {
  url: string;
  title?: string;
  host?: string;
}): boolean {
  const host = extractCleanHost(page.url, page.host);
  if (COMMUNITY_FORUM_HOST_RE.test(host)) return false;
  if (KNOWN_DIRECTORY_HOST_RE.test(host)) return true;
  try {
    const pathname = new URL(page.url).pathname;
    if (SELF_SERVE_DIRECTORY_PATH_RE.test(pathname)) return true;
  } catch {
    // Ignore malformed URLs
  }
  return false;
}

export function getExternalListingType(page: {
  url: string;
  title?: string;
  host?: string;
}): ExternalListingType {
  return isSelfServeDirectoryPage(page) ? 'directory' : 'editorial_roundup';
}

/**
 * Classifies AI-cited external pages into listing/outreach targets (`directory_listing`,
 * which covers both self-serve directories and editorial comparison roundups via `listingType`)
 * vs interactive community threads (`community_post`).
 */
export function classifyCitedExternalPage(page: {
  url: string;
  title: string;
  host?: string;
}): 'directory_listing' | 'community_post' {
  if (isCommunityForumPage(page)) return 'community_post';
  if (isSelfServeDirectoryPage(page)) return 'directory_listing';
  if (EDITORIAL_ROUNDUP_RE.test(`${page.url} ${page.title}`)) {
    return 'directory_listing';
  }
  return 'community_post';
}

function titleCaseSlug(rawSlug: string): string {
  const cleaned = decodeURIComponent(rawSlug)
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const words = cleaned.split(' ').filter(Boolean);
  return words
    .map((word, idx) => {
      const lower = word.toLowerCase();
      if (ACRONYM_MAP[lower]) return ACRONYM_MAP[lower];
      if (idx > 0 && LOWERCASE_SMALL_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

function extractReadableSlugFromUrl(rawUrl: string): { topic: string; redditSub?: string } {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host.includes('google.') && u.pathname === '/goto') return { topic: '' };
    const segments = u.pathname
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!segments.length) return { topic: '' };

    if (host.endsWith('reddit.com')) {
      const rIdx = segments.findIndex((s) => s.toLowerCase() === 'r');
      const sub = rIdx >= 0 && segments[rIdx + 1] ? `r/${segments[rIdx + 1]}` : undefined;
      const cIdx = segments.findIndex((s) => s.toLowerCase() === 'comments');
      const slugSeg = cIdx >= 0 ? segments[cIdx + 2] : '';
      if (slugSeg && slugSeg.length >= 4) {
        const readable = decodeURIComponent(slugSeg).replace(/[-_]+/g, ' ').trim();
        const capped = readable.charAt(0).toUpperCase() + readable.slice(1);
        return { topic: capped, redditSub: sub };
      }
      return { topic: '', redditSub: sub };
    }

    const skipSegs = new Set([
      'blog', 'blogs', 'guide', 'guides', 'article', 'articles', 'post', 'posts',
      'resources', 'learn', 'ai', 'en', 'zh', 'categories', 'category', 'tools',
    ]);
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const seg = segments[i];
      if (!seg || /^\d+$/.test(seg) || seg.length < 4) continue;
      if (skipSegs.has(seg.toLowerCase())) continue;
      if (seg.includes('-') || seg.includes('_') || seg.length >= 12) {
        return { topic: titleCaseSlug(seg) };
      }
    }
    return { topic: '' };
  } catch {
    return { topic: '' };
  }
}

function isBareSiteOrPlatformTitle(title: string, host: string): boolean {
  const trimmed = title.trim();
  const lower = trimmed.toLowerCase().replace(/^www\./, '');
  if (!trimmed) return true;
  if (host && (lower === host || lower.replace(/\.[a-z]{2,}$/, '') === host.replace(/\.[a-z]{2,}$/, ''))) {
    return true;
  }
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(trimmed)) return true;
  if (/^reddit(?:\s*[·•|-]\s*r\/[a-z0-9_]+)?$/i.test(trimmed)) return true;
  if (/^(?:quora|youtube|medium|substack|zapier|sitepoint|g2|capterra)$/i.test(trimmed)) {
    return true;
  }
  // Short author/publisher label (e.g. "Esteve Castells") without any topic punctuation or question words
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length <= 2 && !/[?:!0-9]/.test(trimmed) && !/\b(?:best|top|how|what|why|tools|alternatives|guide)\b/i.test(trimmed)) {
    return true;
  }
  return false;
}

/**
 * Turns bare Google AIO publisher titles ("AccessibilityChecker.org", "canonry.ai",
 * "Reddit · r/AI_Agents", "Esteve Castells") into clear human-readable titles by
 * combining the URL slug topic with the site name.
 */
export function humanizeCitedPageTitle(
  rawTitle: string,
  url: string,
  host?: string,
): string {
  const cleanTitle = rawTitle.replace(/\s+/g, ' ').trim();
  const cleanHost = extractCleanHost(url, host);
  if (!isBareSiteOrPlatformTitle(cleanTitle, cleanHost)) {
    return cleanTitle;
  }
  const { topic, redditSub } = extractReadableSlugFromUrl(url);
  if (!topic) return cleanTitle || cleanHost || url;
  const trimmedTopic = topic.length > 68 ? `${topic.slice(0, 67).trimEnd()}…` : topic;
  if (redditSub) {
    return `${redditSub}: ${trimmedTopic}`;
  }
  const siteSuffix = cleanTitle && cleanTitle.toLowerCase() !== trimmedTopic.toLowerCase()
    ? cleanTitle
    : cleanHost;
  return siteSuffix ? `${trimmedTopic} — ${siteSuffix}` : trimmedTopic;
}

const HAS_CJK_RE = /[\u3400-\u9fff]/;

/**
 * Shorten a summary without ending mid-sentence: keep whole sentences that fit, else end at the
 * last clause break (":", ";", " —", ",") as a sentence, else at the last whole word with "…".
 */
export function wholeSummary(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const head = clean.slice(0, max + 1);
  const sentenceEnd = Math.max(...[...head.matchAll(/[.!?。！？](?=\s|$)/g)].map((m) => m.index + 1), 0);
  if (sentenceEnd >= max * 0.4) return clean.slice(0, sentenceEnd);
  const clauseBreak = Math.max(...[...head.matchAll(/[:;,，；：]\s|\s[—–-]\s/g)].map((m) => m.index), 0);
  if (clauseBreak >= max * 0.4) return `${clean.slice(0, clauseBreak).trimEnd()}.`;
  const wordEnd = head.lastIndexOf(' ');
  return `${clean.slice(0, wordEnd > 0 ? wordEnd : max - 1).trimEnd()}…`;
}

export function findPublicProjectScreenshotUrl(
  repositoryUrl: string | null | undefined,
  assets: Array<{ sourcePath?: string; markdown?: string }>,
): string {
  const readmeAsset =
    assets.find((a) => /(?:^|\/)readme(?:\.[a-z-]+)?\.md$/i.test(a.sourcePath || '')) ??
    assets[0];
  const markdown = (readmeAsset?.markdown || '').slice(0, 14_000);
  if (!markdown) return '';
  const imgMatch =
    markdown.match(/!\[[^\]]*\]\(([^)\s]+?\.(?:png|jpg|jpeg|webp))\)/i) ??
    markdown.match(/<img[^>]+src=["']([^"']+?\.(?:png|jpg|jpeg|webp))["']/i);
  const raw = imgMatch?.[1]?.trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  const ghMatch = (repositoryUrl || '').match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i);
  if (!ghMatch) return '';
  const owner = ghMatch[1];
  const repo = ghMatch[2].replace(/\.git$/i, '');
  return `https://raw.githubusercontent.com/${owner}/${repo}/main/${raw.replace(/^\.?\//, '')}`;
}

export function buildDefaultDirectoryListingDraft(
  project: {
    name: string;
    description?: string | null;
    englishSummary?: string | null;
    screenshotUrl?: string | null;
    repositoryUrl?: string | null;
    siteUrl?: string | null;
  },
  page: { title: string; url: string; host?: string },
): DirectoryListingDraft {
  const productUrl = (project.siteUrl || project.repositoryUrl || '').trim();
  const rawSummary = (project.description || '').replace(/\s+/g, ' ').trim();
  const engFallback = (project.englishSummary || '').replace(/\s+/g, ' ').trim();
  const screenshotUrl = (project.screenshotUrl || '').trim();
  const pageIsChinese = HAS_CJK_RE.test(page.title);
  const chosenSummary =
    !pageIsChinese && HAS_CJK_RE.test(rawSummary)
      ? !HAS_CJK_RE.test(engFallback) && engFallback.length >= 16
        ? engFallback
        : ''
      : rawSummary;
  const oneLiner = chosenSummary
    ? wholeSummary(chosenSummary, 140)
    : `${project.name}${productUrl ? ` (${productUrl})` : ''}`;
  const host = extractCleanHost(page.url, page.host);
  const directoryName = host || page.title;
  const listingType = getExternalListingType(page);
  const readableTitle = humanizeCitedPageTitle(page.title, page.url, host);
  const isOpenSourceRepo = Boolean(project.repositoryUrl && /github\.com\//i.test(project.repositoryUrl));

  if (listingType === 'editorial_roundup') {
    const angleSentence = isOpenSourceRepo
      ? `Most tools in similar roundups are paid cloud SaaS platforms — if you update the post, adding a free, open-source self-hosted option could make the comparison more complete.`
      : `If you update the post, you might consider adding ${project.name} as an alternative option for readers comparing tools in this space.`;
    const blurbCore = chosenSummary
      ? `- ${project.name}${productUrl ? ` (${productUrl})` : ''}: ${oneLiner}`
      : `- ${project.name}${productUrl ? ` (${productUrl})` : ''}${isOpenSourceRepo ? ': Open-source, self-hosted option (no monthly SaaS subscription).' : ''}`;
    const pitch = [
      `Subject: ${isOpenSourceRepo ? 'Open-source option' : 'Option'} to consider for "${readableTitle}"`,
      '',
      `Hi ${host ? `${host} team` : 'team'},`,
      '',
      `I read your guide (${page.url}). ${angleSentence}`,
      '',
      `Ready-to-paste blurb (feel free to edit):`,
      blurbCore,
      ...(screenshotUrl ? [`- Product screenshot: ${screenshotUrl}`] : []),
      '',
      `No pressure at all — happy to send updated screenshots or any verification details if useful.`,
    ].join('\n');
    return {
      listingType,
      directoryName,
      submitUrl: page.url,
      productUrl,
      oneLiner,
      submissionPitch: pitch,
    };
  }

  return {
    listingType,
    directoryName,
    submitUrl: page.url,
    productUrl,
    oneLiner,
    submissionPitch: [
      `Product: ${project.name}`,
      ...(productUrl ? [`URL: ${productUrl}`] : []),
      `Summary: ${oneLiner}`,
      `Note: Submitting ${project.name} for listing consideration on ${directoryName}. Happy to provide any additional screenshots or verification details.`,
    ].join('\n'),
  };
}

export function resolveActionListingType(
  item: Pick<OutreachActionRecord, 'targetUrl' | 'title' | 'listingDraft'>,
): ExternalListingType {
  if (item.listingDraft?.listingType) return item.listingDraft.listingType;
  return getExternalListingType({ url: item.targetUrl, title: item.title });
}

export function describeExternalListingCopy(
  item: Pick<OutreachActionRecord, 'targetUrl' | 'title' | 'listingDraft'>,
  isEn: boolean,
): {
  listingType: ExternalListingType;
  host: string;
  badge: string;
  compactTag: string;
  openLinkLabel: string;
  howToExplain: string;
  draftFieldLabel: string;
  copyBtnLabel: string;
  copyAndOpenBtnLabel: string;
  markPlaceholder: string;
} {
  const listingType = resolveActionListingType(item);
  const host = extractCleanHost(item.targetUrl, item.listingDraft?.directoryName) || item.title;
  if (listingType === 'editorial_roundup') {
    return {
      listingType,
      host,
      badge: isEn ? 'Editorial comparison article' : '第三方测评文章',
      compactTag: isEn ? 'Comparison article · pitch author' : '第三方测评文章 · 联系作者',
      openLinkLabel: isEn ? 'Open article' : '打开原文章',
      howToExplain: isEn
        ? `This is a third-party comparison article on ${host} (not a self-serve directory). Skip blog comments (usually ignored); look for the site's Contact/Editorial page or author email to send the ready-to-paste blurb below. If they ask for a paid placement fee, just Skip.`
        : `这是「${host}」上的第三方测评文章（不是自助提交目录）。不要在文章底部评论区留链接（基本无效）；去网站页脚找 Contact / Editorial 或文章作者邮箱，发送下方带现成段落与截图的自荐信。如对方要求付费插链或分佣，直接点「暂不采用」跳过即可。`,
      draftFieldLabel: isEn
        ? 'Short outreach pitch to the author / editor (editable)'
        : '给文章作者 / 编辑的自荐信（可微调后复制）',
      copyBtnLabel: isEn ? 'Copy pitch' : '复制自荐信',
      copyAndOpenBtnLabel: isEn ? 'Copy pitch & open article' : '复制自荐信并打开文章',
      markPlaceholder: isEn
        ? 'Required: paste the article URL or confirmation link (https://...)'
        : '必填：粘贴收录后的文章链接或联系确认链接（https://...）',
    };
  }
  return {
    listingType,
    host,
    badge: isEn ? 'Software directory' : '软件目录站',
    compactTag: isEn ? 'Software directory · submit product' : '软件目录站 · 提交产品',
    openLinkLabel: isEn ? 'Open directory' : '打开目录页',
    howToExplain: isEn
      ? `${host} is a software directory already cited by AI answers. Open the directory page, locate its Submit / Add Product form, and paste the product summary below.`
      : `「${host}」是已被 AI 回答引用的软件收录目录站。打开目录页找到提交/上架入口，把下方产品介绍粘贴填表提交即可。`,
    draftFieldLabel: isEn
      ? 'Product submission details (ready to paste into the form)'
      : '产品提交资料（可直接复制粘贴到目录表单）',
    copyBtnLabel: isEn ? 'Copy details' : '复制提交资料',
    copyAndOpenBtnLabel: isEn ? 'Copy & open directory' : '复制资料并打开目录页',
    markPlaceholder: isEn
      ? 'Required: paste your live listing or submission URL (https://...)'
      : '必填：粘贴提交后的目录页或收录凭证链接（https://...）',
  };
}

export function isPrimaryActionableOutreach(item: OutreachActionRecord): boolean {
  if (item.kind === 'awesome_pr' || item.kind === 'repo_meta') return true;
  if (item.kind === 'directory_listing') {
    return resolveActionListingType(item) === 'directory';
  }
  return item.id.startsWith('post:thread:');
}

export function formatExternalPackCopy(
  items: OutreachActionRecord[],
  isEn: boolean,
): {
  allAwesome: boolean;
  allDirectoryKind: boolean;
  allEditorialRoundup: boolean;
  allCommunityThreads: boolean;
  title: string;
  desc: string;
  primaryCtaLabel: (selectedCount: number) => string;
} {
  const count = items.length;
  const allAwesome = count > 0 && items.every((i) => i.kind === 'awesome_pr');
  const allDirectoryKind = count > 0 && items.every((i) => i.kind === 'directory_listing');
  const allEditorialRoundup =
    allDirectoryKind && items.every((i) => resolveActionListingType(i) === 'editorial_roundup');
  const allCommunityThreads =
    count > 0 && items.every((i) => i.kind === 'community_post' && i.id.startsWith('post:thread:'));

  if (allAwesome) {
    return {
      allAwesome,
      allDirectoryKind,
      allEditorialRoundup,
      allCommunityThreads,
      title: isEn
        ? `Submit listing PRs to ${count} open-source lists`
        : `向 ${count} 个开源导航清单提收录 PR`,
      desc: isEn
        ? 'Curated open-source lists already cited in your live AI answers — review the diff and submit PRs.'
        : '这些开源工具清单已被 ChatGPT / Google 直接引用，AI 已为你核对分类与插入行。',
      primaryCtaLabel: (n) =>
        isEn
          ? `Prepare & review ${n} ${n === 1 ? 'PR' : 'PRs'}`
          : `准备并核对已选 ${n} 个 PR`,
    };
  }

  if (allCommunityThreads) {
    return {
      allAwesome,
      allDirectoryKind,
      allEditorialRoundup,
      allCommunityThreads,
      title: isEn
        ? `Reply in ${count} AI-cited community threads`
        : `参与 ${count} 条 AI 引用的社区求助帖`,
      desc: isEn
        ? 'Buyers are already asking these questions on threads cited by AI — no editor approval needed. Open a thread to read the context, then generate a concise factual reply.'
        : '这些真实求助帖已被 AI 回答直接引用，不需要等第三方编辑审核。先打开原帖看清上下文，再一键生成一段克制的实战经验回复。',
      primaryCtaLabel: (n) =>
        isEn
          ? `Review ${n} ${n === 1 ? 'thread' : 'threads'}`
          : `查看这 ${n} 条求助帖`,
    };
  }

  if (allEditorialRoundup) {
    return {
      allAwesome,
      allDirectoryKind,
      allEditorialRoundup,
      allCommunityThreads,
      title: isEn
        ? `Pitch ${count} AI-cited comparison articles`
        : `联系 ${count} 篇 AI 引用的测评文章作者`,
      desc: isEn
        ? 'These third-party comparison articles were cited by AI answers (not self-serve directories). Open an article directly to see if it fits, then draft a short pitch if worthwhile.'
        : '这些第三方测评文章已被 AI 回答直接引用（不是自助目录）。先点「打开原文看看」判断网站值不值得联系，觉得合适再点「准备自荐信」。',
      primaryCtaLabel: (n) =>
        isEn
          ? `View ${n} ${n === 1 ? 'article & pitch' : 'articles & pitches'}`
          : `查看这 ${n} 篇文章与自荐信`,
    };
  }

  if (allDirectoryKind) {
    return {
      allAwesome,
      allDirectoryKind,
      allEditorialRoundup,
      allCommunityThreads,
      title: isEn
        ? `Submit to ${count} AI-cited software directories`
        : `向 ${count} 个 AI 引用的软件目录站提交产品`,
      desc: isEn
        ? 'Software directories already cited by AI answers. Open a directory page directly or prepare your submission summary.'
        : '这些软件目录站已被 AI 回答直接引用。可直接打开目录页查看入口，或点「准备提交资料」按需复制。',
      primaryCtaLabel: (n) =>
        isEn
          ? `Review & open ${n} ${n === 1 ? 'directory' : 'directories'}`
          : `查看提交资料并逐个打开（${n}）`,
    };
  }

  return {
    allAwesome,
    allDirectoryKind,
    allEditorialRoundup,
    allCommunityThreads,
    title: isEn
      ? `Act on ${count} direct external visibility channels`
      : `推进 ${count} 项可直接落地的外部渠道`,
    desc: isEn
      ? 'AI-cited open-source lists, software directories, and live community discussions you can act on directly.'
      : '从实测 AI 引用中挑出可以直接行动的高确定性渠道（开源榜单、软件目录、社区求助帖）。',
    primaryCtaLabel: (n) =>
      isEn
        ? `Review ${n} selected ${n === 1 ? 'item' : 'items'}`
        : `查看并推进已选 ${n} 项`,
  };
}

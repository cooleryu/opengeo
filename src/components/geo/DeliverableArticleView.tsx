'use client';

import {
  Children,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Markdown from 'markdown-to-jsx';
import {
  BookOpen,
  Check,
  CheckCircle2,
  Copy,
  CornerDownLeft,
  ExternalLink,
  Maximize2,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { translateUi, type GeoLanguage } from '@/lib/geo/i18n';
import {
  buildExternalMarkdown,
  buildExternalRichHtml,
  copyRichHtmlToClipboard,
  extractArticleTitle,
  extractGitHubRepoSlug,
  parseMermaidFlowchart,
  resolveRelativeRepoTarget,
  type FlowEdge,
} from '@/lib/geo/optimization/external-export';
import type { OptimizationDeliverable } from '@/lib/geo/optimization/types';
import { useUiLanguage } from './UiLanguageContext';
import './deliverable-article-view.css';

export { resolveRelativeRepoTarget };

function MermaidFlowDiagram({ code }: { code: string }) {
  const [showSource, setShowSource] = useState(false);
  const parsed = useMemo(() => parseMermaidFlowchart(code), [code]);

  if (!parsed) {
    return (
      <pre className="dav-code-block">
        <code>{code}</code>
      </pre>
    );
  }

  const isEnglishDiagram = !/[\p{Script=Han}]/u.test(code);
  const orderIndex = new Map<string, number>();
  const orderedIds: string[] = [];
  for (const id of parsed.nodes.keys()) {
    orderIndex.set(id, orderedIds.length);
    orderedIds.push(id);
  }

  const forwardEdges: FlowEdge[] = [];
  const loopEdges: FlowEdge[] = [];
  for (const edge of parsed.edges) {
    const fromIdx = orderIndex.get(edge.from) ?? 0;
    const toIdx = orderIndex.get(edge.to) ?? 0;
    if (toIdx <= fromIdx) {
      loopEdges.push(edge);
    } else {
      forwardEdges.push(edge);
    }
  }

  const incomingLabelByNode = new Map<string, string[]>();
  for (const edge of forwardEdges) {
    if (edge.label) {
      const prev = incomingLabelByNode.get(edge.to) ?? [];
      prev.push(edge.label);
      incomingLabelByNode.set(edge.to, prev);
    }
  }

  const loopsBySource = new Map<string, FlowEdge[]>();
  for (const loop of loopEdges) {
    const list = loopsBySource.get(loop.from) ?? [];
    list.push(loop);
    loopsBySource.set(loop.from, list);
  }

  return (
    <figure
      className="dav-diagram"
      aria-label={isEnglishDiagram ? 'Workflow overview flowchart' : '步骤流程示意图'}
    >
      <div className="dav-diagram-bar">
        <span className="dav-diagram-tag">
          {isEnglishDiagram
            ? 'Workflow Overview · Mermaid Flowchart'
            : '步骤一览 · Mermaid 流程图'}
        </span>
        <button
          type="button"
          className="dav-diagram-toggle"
          onClick={() => setShowSource((v) => !v)}
        >
          {showSource
            ? isEnglishDiagram
              ? 'Card View'
              : '卡片视图'
            : isEnglishDiagram
              ? 'Mermaid Code'
              : 'Mermaid 源码'}
        </button>
      </div>

      {showSource ? (
        <pre className="dav-diagram-source">
          <code>{code}</code>
        </pre>
      ) : (
        <ol className={`dav-flow-list is-${parsed.direction.toLowerCase()}`}>
          {orderedIds.map((id, idx) => {
            const node = parsed.nodes.get(id)!;
            const branchLabels = incomingLabelByNode.get(id);
            const nodeLoops = loopsBySource.get(id) ?? [];
            const stepNum = idx + 1;

            return (
              <li key={id} className="dav-flow-step">
                {idx > 0 && (
                  <div className="dav-flow-connector" aria-hidden="true">
                    <span className="dav-flow-line" />
                    {branchLabels?.length ? (
                      <span className="dav-flow-edge-pill">
                        {branchLabels.join(' / ')}
                      </span>
                    ) : null}
                  </div>
                )}

                <div className={`dav-flow-node is-${node.shape}`}>
                  <span className="dav-flow-index">
                    {node.shape === 'decision' ? '?' : stepNum}
                  </span>
                  <span className="dav-flow-text">{node.label}</span>
                </div>

                {nodeLoops.length > 0 && (
                  <div className="dav-flow-loops">
                    {nodeLoops.map((loop, loopIdx) => {
                      const targetIndex = (orderIndex.get(loop.to) ?? 0) + 1;
                      const targetNode = parsed.nodes.get(loop.to);
                      return (
                        <div key={loopIdx} className="dav-flow-loop-badge">
                          <CornerDownLeft size={13} />
                          <span>
                            {isEnglishDiagram
                              ? `${loop.label ? `${loop.label}: ` : 'Loop: '}back to Step ${targetIndex}${targetNode ? ` (${targetNode.label})` : ''}`
                              : `${loop.label ? `${loop.label}：` : '循环：'}回到第 ${targetIndex} 步${targetNode ? `（${targetNode.label}）` : ''}`}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </figure>
  );
}

function extractCodeBlock(children: ReactNode): { lang: string; text: string } | null {
  const arr = Children.toArray(children);
  if (arr.length !== 1) return null;
  const first = arr[0];
  if (isValidElement<{ className?: string; children?: ReactNode }>(first)) {
    const className = first.props.className || '';
    const langMatch = className.match(/lang(?:uage)?-([A-Za-z0-9_-]+)/i);
    const rawChildren = first.props.children;
    const text = Array.isArray(rawChildren)
      ? rawChildren.join('')
      : typeof rawChildren === 'string'
        ? rawChildren
        : '';
    return {
      lang: (langMatch?.[1] || '').toLowerCase(),
      text: text.replace(/\n$/, ''),
    };
  }
  return null;
}

export function resolveDeliverableMediaSrc(
  rawSrc: string,
  projectId: string,
  destination: string,
): string {
  if (!rawSrc) return '';
  if (/^(?:https?:|data:|blob:)/i.test(rawSrc)) return rawSrc;
  const params = new URLSearchParams({
    project: projectId,
    destination,
    path: rawSrc,
  });
  return `/api/geo/project-media?${params.toString()}`;
}

export function estimateReadingMinutes(markdown: string): number {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\s+/g, '');
  return Math.max(2, Math.round(plain.length / 480));
}

export function extractPlainLeadExcerpt(markdown: string, maxChars = 110): string {
  const withoutHero = markdown.replace(
    /^\s*<div[^>]*align=["']center["'][^>]*>[\s\S]*?<\/div>\s*/i,
    '',
  );
  const blocks = withoutHero
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<\/?(?:details|summary|sub|br|p|h[1-6]|div)[^>]*>/gi, '\n')
    .split(/\n{2,}/)
    .map((line) => line.trim())
    .filter((line) => {
      if (
        !line ||
        line.startsWith('#') ||
        line.startsWith('|') ||
        line.startsWith('![') ||
        line.startsWith('>')
      ) {
        return false;
      }
      const withoutLinks = line
        .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
        .replace(/\[[^\]]*\]\([^)]+\)/g, '')
        .replace(/<a\s+[^>]*>[\s\S]*?<\/a>/gi, '')
        .replace(/[·|/\s—–-]+/g, '')
        .trim();
      return Boolean(withoutLinks);
    });
  const first = (blocks[0] || '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<a\s+[^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (first.length <= maxChars) return first;
  return `${first.slice(0, maxChars).replace(/[，。、；：,.!?\s]+$/, '')}……`;
}

export function extractFirstScreenshotSrc(
  projectId: string,
  deliverable: OptimizationDeliverable,
): { src: string; caption: string } | null {
  const fromManifest = deliverable.mediaManifest.find((m) => m.type === 'screenshot');
  if (fromManifest?.pathOrTitle) {
    return {
      src: resolveDeliverableMediaSrc(
        fromManifest.pathOrTitle,
        projectId,
        deliverable.destination,
      ),
      caption: fromManifest.caption || deliverable.title,
    };
  }
  const mdMatch = deliverable.afterContent.match(/!\[([^\]]*)\]\(([^)]+)\)/);
  if (mdMatch?.[2]) {
    return {
      src: resolveDeliverableMediaSrc(mdMatch[2], projectId, deliverable.destination),
      caption: mdMatch[1] || deliverable.title,
    };
  }
  return null;
}

/** Collects up to `limit` distinct real screenshots across a package of deliverables. */
export function extractPackageThumbnails(
  projectId: string,
  deliverables: OptimizationDeliverable[],
  limit = 3,
): Array<{ src: string; caption: string }> {
  const results: Array<{ src: string; caption: string }> = [];
  const seenFiles = new Set<string>();

  for (const d of deliverables) {
    const candidates: Array<{ rawPath: string; caption: string }> = [];
    for (const m of d.mediaManifest) {
      if (m.type === 'screenshot' && m.pathOrTitle) {
        candidates.push({ rawPath: m.pathOrTitle, caption: m.caption || d.title });
      }
    }
    for (const match of d.afterContent.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      if (match[2]) {
        candidates.push({ rawPath: match[2], caption: match[1] || d.title });
      }
    }

    for (const item of candidates) {
      const fileKey = item.rawPath.split(/[?#]/)[0].split('/').pop()?.toLowerCase() || item.rawPath;
      if (seenFiles.has(fileKey)) continue;
      seenFiles.add(fileKey);
      results.push({
        src: resolveDeliverableMediaSrc(item.rawPath, projectId, d.destination),
        caption: item.caption,
      });
      if (results.length >= limit) return results;
      break;
    }
  }

  return results;
}

/** Classifies a deliverable into a plain role badge purely from DB fields. */
export function getDeliverableRoleLabel(
  deliverable: OptimizationDeliverable,
  lang: GeoLanguage = 'zh',
): string {
  if (/readme|主页|首页|门面/i.test(`${deliverable.destination} ${deliverable.title}`)) {
    return translateUi(lang, 'dav.roleReadme');
  }
  if (/getting-started|quickstart|快速上手|入门|上手/i.test(`${deliverable.destination} ${deliverable.title}`)) {
    return translateUi(
      lang,
      deliverable.beforeContent?.trim() ? 'dav.roleQuickstartUpdate' : 'dav.roleQuickstartNew',
    );
  }
  if (/how-it-works|compare|workflow|选型|工作方式|对比|原理/i.test(`${deliverable.destination} ${deliverable.title}`)) {
    return translateUi(lang, 'dav.roleWorkflow');
  }
  return translateUi(
    lang,
    deliverable.kind === 'update_asset' ? 'dav.roleUpdateAsset' : 'dav.rolePublicArticle',
  );
}

export interface CenteredHeroLogo {
  src: string;
  alt: string;
  width?: number;
  height?: number;
}

export interface CenteredHeroBlock {
  logo?: CenteredHeroLogo;
  title: string;
  tagline: string;
  paragraphs: string[];
  links: Array<{ label: string; href: string }>;
}

function clampHeroLogoDim(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.max(24, Math.min(140, parsed));
}

function extractSafeImgAttributes(rawTag: string): CenteredHeroLogo | null {
  const srcMatch = rawTag.match(/\bsrc=["']([^"']+)["']/i);
  const src = srcMatch?.[1]?.trim();
  if (!src || /^(?:javascript:|data:)/i.test(src)) return null;
  const altMatch = rawTag.match(/\balt=["']([^"']*)["']/i);
  const widthMatch = rawTag.match(/\bwidth=["']?(\d+)["']?/i);
  const heightMatch = rawTag.match(/\bheight=["']?(\d+)["']?/i);
  return {
    src,
    alt: altMatch?.[1]?.trim() || 'Logo',
    ...(clampHeroLogoDim(widthMatch?.[1]) ? { width: clampHeroLogoDim(widthMatch?.[1]) } : {}),
    ...(clampHeroLogoDim(heightMatch?.[1]) ? { height: clampHeroLogoDim(heightMatch?.[1]) } : {}),
  };
}

function renderInlineBold(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      part
    ),
  );
}

/** Extracts a leading `<div align="center">...</div>` hero block for magpie-style README rendering. */
export function extractCenteredHeroBlock(markdown: string): {
  hero: CenteredHeroBlock | null;
  restMarkdown: string;
} {
  const match = markdown.match(/^\s*<div[^>]*align=["']center["'][^>]*>([\s\S]*?)<\/div>\s*/i);
  if (!match) return { hero: null, restMarkdown: markdown };

  const inner = match[1];
  const restMarkdown = markdown.slice(match[0].length).trimStart();

  let logo: CenteredHeroLogo | undefined;
  const htmlImgMatch = inner.match(/<img\b[^>]*>/i);
  if (htmlImgMatch) {
    logo = extractSafeImgAttributes(htmlImgMatch[0]) ?? undefined;
  } else {
    const mdImgMatch = inner.match(/!\[([^\]]*)\]\(([^)\s]+)\)/);
    if (mdImgMatch && mdImgMatch[2] && !/^(?:javascript:|data:)/i.test(mdImgMatch[2])) {
      logo = { src: mdImgMatch[2].trim(), alt: mdImgMatch[1].trim() || 'Logo' };
    }
  }

  let title = '';
  let tagline = '';
  const paragraphs: string[] = [];
  const links: Array<{ label: string; href: string }> = [];

  const normalizedLines = inner
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of normalizedLines) {
    if (/^#\s+/.test(line) && !title) {
      title = line.replace(/^#\s+/, '').trim();
      continue;
    }
    if (/^###?\s+/.test(line) && !tagline) {
      tagline = line.replace(/^###?\s+/, '').trim();
      continue;
    }

    const mdLinks = [...line.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)];
    const htmlLinks = [...line.matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
    if (mdLinks.length + htmlLinks.length >= 2 || (line.includes('·') && mdLinks.length + htmlLinks.length >= 1)) {
      for (const m of mdLinks) links.push({ label: m[1].replace(/\*\*/g, '').trim(), href: m[2].trim() });
      for (const m of htmlLinks) links.push({ label: m[2].replace(/<[^>]+>/g, '').trim(), href: m[1].trim() });
      continue;
    }

    const cleaned = line
      .replace(/<\/?[^>]+>/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .trim();
    if (cleaned) paragraphs.push(cleaned);
  }

  if (!logo && !title && !tagline && paragraphs.length === 0) {
    return { hero: null, restMarkdown: markdown };
  }

  return { hero: { ...(logo ? { logo } : {}), title, tagline, paragraphs, links }, restMarkdown };
}

/** Converts simple HTML blocks (`<details>`, `<img>`, legacy headers) outside code fences into clean Markdown. */
function normalizeMarkdownForReader(markdown: string): string {
  return markdown
    .split(/(```[^\n]*\r?\n[\s\S]*?\r?\n```)/g)
    .map((segment, index) => {
      if (index % 2 === 1) {
        return `\n\n${segment.trim()}\n\n`;
      }
      return segment
        .replace(/<details[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi, (_all, summary: string, body: string) => {
          const cleanSummary = summary.replace(/<[^>]+>/g, '').trim();
          const cleanBodyLines = body
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/?[^>]+>/g, '')
            .trim()
            .split(/\r?\n/)
            .map((l) => (l.trim() ? `> ${l.trim()}` : '>'));
          return `\n\n> **${cleanSummary}**\n>\n${cleanBodyLines.join('\n')}\n\n`;
        })
        .replace(/<img\b[^>]*>/gi, (tag) => {
          const parsed = extractSafeImgAttributes(tag);
          return parsed ? `![${parsed.alt}](${parsed.src})` : '';
        })
        .replace(/<\/?(?:div|sub|picture|source)[^>]*>/gi, '')
        .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n\n')
        .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n\n')
        .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n\n')
        .replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');
    })
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Extracts a crisp 1-line human purpose summary directly from DB fields. */
export function extractDeliverablePurpose(
  deliverable: OptimizationDeliverable,
  maxChars = 46,
): string {
  const raw = (deliverable.audienceAndGoal || '').replace(/\s+/g, ' ').trim();
  if (raw) {
    const firstClause = raw.split(/[。；！？]/)[0]?.trim() || raw;
    if (firstClause.length <= maxChars) return firstClause;
    return `${firstClause.slice(0, maxChars).replace(/[，、：,\s]+$/, '')}…`;
  }
  return extractPlainLeadExcerpt(deliverable.afterContent, maxChars);
}

export function githubHeadingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

export interface DeliverableArticleViewProps {
  projectId: string;
  deliverable: OptimizationDeliverable;
  repositoryUrl?: string;
  onNavigateRelativeDoc?: (repoPath: string) => boolean;
  showMetaStrip?: boolean;
  hideCopyButton?: boolean;
  externalExportMode?: boolean;
  branch?: string;
  contentOverride?: string;
  destinationOverride?: string;
}

export default function DeliverableArticleView({
  projectId,
  deliverable,
  repositoryUrl,
  onNavigateRelativeDoc,
  showMetaStrip = true,
  hideCopyButton = false,
  externalExportMode = false,
  branch,
  contentOverride,
  destinationOverride,
}: DeliverableArticleViewProps) {
  const { uiLanguage, t } = useUiLanguage();
  const effectiveDestination = destinationOverride ?? deliverable.destination;
  const effectiveBranch = (branch || 'main').trim() || 'main';
  const [copiedKind, setCopiedKind] = useState<'none' | 'title' | 'md' | 'rich'>('none');
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const [showReviewChecks, setShowReviewChecks] = useState(false);
  const [activeWinnerUrl, setActiveWinnerUrl] = useState<string | null>(null);
  const referenceWinners = deliverable.referenceWinners ?? [];
  const activeWinner =
    referenceWinners.find((w) => w.url === activeWinnerUrl) ?? null;

  const rawMarkdown = contentOverride ?? deliverable.afterContent;
  const { hero: centeredHero, renderedMarkdown } = useMemo(() => {
    const extracted = extractCenteredHeroBlock(rawMarkdown);
    return {
      hero: extracted.hero,
      renderedMarkdown: normalizeMarkdownForReader(extracted.restMarkdown),
    };
  }, [rawMarkdown]);
  const readingMinutes = useMemo(
    () => estimateReadingMinutes(rawMarkdown),
    [rawMarkdown],
  );

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const markCopied = (kind: 'title' | 'md' | 'rich') => {
    setCopiedKind(kind);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopiedKind('none'), 2200);
  };

  const exportOptions = {
    markdown: rawMarkdown,
    destination: effectiveDestination,
    repositoryUrl,
    branch: effectiveBranch,
  };

  const copyTitleText = async () => {
    try {
      await navigator.clipboard.writeText(
        extractArticleTitle(rawMarkdown, deliverable.title),
      );
      markCopied('title');
    } catch {
      // Ignore clipboard permission failure in restricted frames
    }
  };

  const copyMarkdownText = async () => {
    try {
      const text = externalExportMode
        ? buildExternalMarkdown(exportOptions)
        : rawMarkdown;
      await navigator.clipboard.writeText(text);
      markCopied('md');
    } catch {
      // Ignore clipboard permission failure in restricted frames
    }
  };

  const copyRichHtmlText = async () => {
    try {
      const html = buildExternalRichHtml(exportOptions);
      const plain = buildExternalMarkdown(exportOptions);
      await copyRichHtmlToClipboard(html, plain);
      markCopied('rich');
    } catch {
      // Ignore clipboard permission failure in restricted frames
    }
  };

  const review = deliverable.review;

  const renderSmartLink = (href: string, children: ReactNode, key?: string) => {
    if (href.startsWith('#')) {
      return (
        <a
          key={key}
          href={href}
          onClick={(e) => {
            e.preventDefault();
            const raw = decodeURIComponent(href.slice(1));
            const target =
              document.getElementById(raw) ||
              document.getElementById(githubHeadingSlug(raw));
            target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
        >
          {children}
        </a>
      );
    }
    const rel = resolveRelativeRepoTarget(href, effectiveDestination);
    if (rel) {
      const repoSlug = extractGitHubRepoSlug(repositoryUrl);
      const githubHref = repoSlug
        ? `https://github.com/${repoSlug}/blob/${effectiveBranch}/${rel.repoPath}${rel.hash}`
        : href;
      return (
        <a
          key={key}
          href={githubHref}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => {
            if (onNavigateRelativeDoc?.(rel.repoPath)) {
              e.preventDefault();
            }
          }}
        >
          {children}
        </a>
      );
    }
    return (
      <a key={key} href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  };

  return (
    <div className="dav-root">
      {showMetaStrip && (
        <div className="dav-meta-strip">
          <div className="dav-meta-left">
            <span className="dav-path-chip">
              <BookOpen size={13} />
              <span>
                {getDeliverableRoleLabel(deliverable, uiLanguage)} ·{' '}
                {t('dav.readMinutes', { minutes: readingMinutes })}
              </span>
            </span>
            {review?.verdict === 'pass' && (
              <button
                type="button"
                className="dav-review-pill is-pass"
                aria-expanded={showReviewChecks}
                onClick={() => setShowReviewChecks((v) => !v)}
              >
                <ShieldCheck size={13} />
                <span>{t('dav.verifiedFactReadability')}</span>
              </button>
            )}
          </div>

          {!hideCopyButton &&
            (externalExportMode ? (
              <div className="dav-copy-group">
                <button
                  type="button"
                  className="dav-copy-btn"
                  onClick={() => void copyTitleText()}
                >
                  {copiedKind === 'title' ? <Check size={13} /> : <Copy size={13} />}
                  <span>
                    {t(copiedKind === 'title' ? 'dav.copiedTitle' : 'dav.copyTitle')}
                  </span>
                </button>
                <button
                  type="button"
                  className="dav-copy-btn"
                  onClick={() => void copyRichHtmlText()}
                >
                  {copiedKind === 'rich' ? <Check size={13} /> : <Copy size={13} />}
                  <span>
                    {t(copiedKind === 'rich' ? 'dav.copiedRichText' : 'dav.copyRichText')}
                  </span>
                </button>
                <button
                  type="button"
                  className="dav-copy-btn is-primary"
                  onClick={() => void copyMarkdownText()}
                >
                  {copiedKind === 'md' ? <Check size={13} /> : <Copy size={13} />}
                  <span>
                    {t(
                      copiedKind === 'md'
                        ? 'dav.copiedExternalMd'
                        : 'dav.copyExternalMd',
                    )}
                  </span>
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="dav-copy-btn"
                onClick={() => void copyMarkdownText()}
              >
                {copiedKind === 'md' ? <Check size={13} /> : <Copy size={13} />}
                <span>
                  {t(copiedKind === 'md' ? 'dav.copiedFull' : 'dav.copyFull')}
                </span>
              </button>
            ))}
        </div>
      )}

      {showMetaStrip && showReviewChecks && review && (
        <div className="dav-review-drawer">
          <div className="dav-review-item">
            <CheckCircle2 size={14} />
            <div>
              <strong>{t('dav.checkAuth')}</strong>
              <p>{review.checks.authenticity.note}</p>
            </div>
          </div>
          <div className="dav-review-item">
            <CheckCircle2 size={14} />
            <div>
              <strong>{t('dav.checkComp')}</strong>
              <p>{review.checks.compliance.note}</p>
            </div>
          </div>
          <div className="dav-review-item">
            <CheckCircle2 size={14} />
            <div>
              <strong>{t('dav.checkRead')}</strong>
              <p>{review.checks.readability.note}</p>
            </div>
          </div>
        </div>
      )}

      {showMetaStrip && referenceWinners.length > 0 && (
        <section className="dav-winners-bar" aria-label={t('dav.winnersLabel', { count: referenceWinners.length })}>
          <div className="dav-winners-head">
            <span className="dav-winners-title">
              <Sparkles size={13} />
              <span>{t('dav.winnersLabel', { count: referenceWinners.length })}</span>
            </span>
            <span className="dav-winners-hint">{t('dav.winnersHint')}</span>
          </div>
          <div className="dav-winners-pills">
            {referenceWinners.map((winner) => {
              const selected = activeWinnerUrl === winner.url;
              return (
                <button
                  key={winner.url}
                  type="button"
                  className={`dav-winner-pill ${selected ? 'is-active' : ''}`}
                  aria-expanded={selected}
                  onClick={() =>
                    setActiveWinnerUrl((curr) => (curr === winner.url ? null : winner.url))
                  }
                >
                  <span className="dav-winner-domain">{winner.domain}</span>
                  <span className="dav-winner-status">
                    {winner.probeStatus === 'local_fallback'
                      ? t('dav.winnerLocalFallback')
                      : t('dav.winnerFullRead')}
                  </span>
                </button>
              );
            })}
          </div>
          {activeWinner && (
            <div className="dav-winner-preview">
              <div className="dav-winner-preview-top">
                <strong>{activeWinner.title}</strong>
                <a
                  href={activeWinner.url}
                  target="_blank"
                  rel="noreferrer"
                  className="dav-winner-ext"
                >
                  <span>{t('dav.winnerVisitLink')}</span>
                  <ExternalLink size={12} />
                </a>
              </div>
              {activeWinner.probeStatus !== 'local_fallback' &&
                activeWinner.headings.length > 0 && (
                  <div className="dav-winner-block">
                    <span className="dav-winner-sub">{t('dav.winnerHeadingsLabel')}</span>
                    <div className="dav-winner-headings">
                      {activeWinner.headings.map((heading, idx) => (
                        <span key={idx} className="dav-winner-h2">
                          {heading}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              {activeWinner.openingParagraphs.length > 0 ? (
                <div className="dav-winner-block">
                  <span className="dav-winner-sub">{t('dav.winnerOpeningLabel')}</span>
                  {activeWinner.openingParagraphs.map((para, idx) => (
                    <p key={idx}>{para}</p>
                  ))}
                </div>
              ) : (
                <div className="dav-winner-block">
                  <span className="dav-winner-sub">{t('dav.winnerSnippetLabel')}</span>
                  <p>{activeWinner.localSnippet}</p>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      <article className="dav-prose">
        {centeredHero && (
          <header className="dav-readme-hero">
            {centeredHero.logo && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                className="dav-readme-logo"
                src={resolveDeliverableMediaSrc(
                  centeredHero.logo.src,
                  projectId,
                  effectiveDestination,
                )}
                alt={centeredHero.logo.alt}
                width={centeredHero.logo.width || 80}
                height={centeredHero.logo.height || 80}
              />
            )}
            {centeredHero.title && <h1>{centeredHero.title}</h1>}
            {centeredHero.tagline && (
              <p className="dav-readme-tagline">{centeredHero.tagline}</p>
            )}
            {centeredHero.paragraphs.length > 0 && (
              <div className="dav-readme-desc">
                {centeredHero.paragraphs.map((line, idx) => (
                  <span key={idx}>{renderInlineBold(line)}</span>
                ))}
              </div>
            )}
            {centeredHero.links.length > 0 && (
              <nav className="dav-readme-nav" aria-label="文档快速导航">
                {centeredHero.links.map((link, idx) => (
                  <span key={`${link.href}-${idx}`}>
                    {idx > 0 && <span className="dav-readme-sep"> · </span>}
                    {renderSmartLink(link.href, link.label)}
                  </span>
                ))}
              </nav>
            )}
          </header>
        )}
        <Markdown
          options={{
            disableParsingRawHTML: true,
            slugify: githubHeadingSlug,
            overrides: {
              pre: {
                component: ({ children }: { children?: ReactNode }) => {
                  const extracted = extractCodeBlock(children);
                  if (extracted?.lang === 'mermaid') {
                    return <MermaidFlowDiagram code={extracted.text} />;
                  }
                  return <pre className="dav-code-block">{children}</pre>;
                },
              },
              table: {
                component: ({ children }: { children?: ReactNode }) => (
                  <div className="dav-table-wrap">
                    <table>{children}</table>
                  </div>
                ),
              },
              img: {
                component: ({
                  src = '',
                  alt = '',
                }: {
                  src?: string;
                  alt?: string;
                }) => {
                  const resolved = resolveDeliverableMediaSrc(
                    src,
                    projectId,
                    effectiveDestination,
                  );
                  return (
                    <span className="dav-figure">
                      <button
                        type="button"
                        className="dav-figure-frame"
                        onClick={() => setLightbox({ src: resolved, alt })}
                        aria-label={alt ? `放大查看：${alt}` : '放大查看配图'}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={resolved} alt={alt} loading="lazy" />
                        <span className="dav-figure-zoom" aria-hidden="true">
                          <Maximize2 size={13} />
                        </span>
                      </button>
                      {alt && <span className="dav-figcaption">{alt}</span>}
                    </span>
                  );
                },
              },
              a: {
                component: ({
                  href = '',
                  children,
                }: {
                  href?: string;
                  children?: ReactNode;
                }) => renderSmartLink(href, children),
              },
            },
          }}
        >
          {renderedMarkdown}
        </Markdown>
      </article>

      {lightbox && (
        <div
          className="dav-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={lightbox.alt || '配图预览'}
          onClick={() => setLightbox(null)}
        >
          <div
            className="dav-lightbox-inner"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="dav-lightbox-close"
              aria-label="关闭大图"
              onClick={() => setLightbox(null)}
            >
              <X size={18} />
            </button>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={lightbox.src} alt={lightbox.alt} />
            {lightbox.alt && <p>{lightbox.alt}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

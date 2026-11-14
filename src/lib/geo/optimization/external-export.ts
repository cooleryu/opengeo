export interface FlowNode {
  id: string;
  label: string;
  shape: 'rect' | 'decision' | 'round';
}

export interface FlowEdge {
  from: string;
  to: string;
  label?: string;
}

export interface ParsedFlowchart {
  direction: 'TD' | 'LR';
  nodes: Map<string, FlowNode>;
  edges: FlowEdge[];
}

export interface ExternalExportOptions {
  markdown: string;
  destination: string;
  repositoryUrl?: string;
  branch?: string;
  stripLeadingH1?: boolean;
  convertMermaidToSteps?: boolean;
}

function cleanMermaidLabel(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/<br\s*\/?>/gi, ' / ')
    .trim();
}

function upsertTokenNode(nodes: Map<string, FlowNode>, rawToken: string): string | null {
  const token = rawToken.trim();
  if (!token) return null;

  const rectMatch = token.match(/^([A-Za-z0-9_-]+)\s*\[\s*([\s\S]+?)\s*\]$/);
  if (rectMatch) {
    const id = rectMatch[1];
    nodes.set(id, { id, label: cleanMermaidLabel(rectMatch[2]), shape: 'rect' });
    return id;
  }

  const decisionMatch = token.match(/^([A-Za-z0-9_-]+)\s*\{\s*([\s\S]+?)\s*\}$/);
  if (decisionMatch) {
    const id = decisionMatch[1];
    nodes.set(id, { id, label: cleanMermaidLabel(decisionMatch[2]), shape: 'decision' });
    return id;
  }

  const roundMatch = token.match(/^([A-Za-z0-9_-]+)\s*\(\s*([\s\S]+?)\s*\)$/);
  if (roundMatch) {
    const id = roundMatch[1];
    nodes.set(id, { id, label: cleanMermaidLabel(roundMatch[2]), shape: 'round' });
    return id;
  }

  const bareMatch = token.match(/^([A-Za-z0-9_-]+)$/);
  if (bareMatch) {
    const id = bareMatch[1];
    if (!nodes.has(id)) {
      nodes.set(id, { id, label: id, shape: 'rect' });
    }
    return id;
  }

  return null;
}

export function parseMermaidFlowchart(code: string): ParsedFlowchart | null {
  const lines = code
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('%%'));

  if (!lines.length) return null;
  const headerMatch = lines[0].match(/^(?:flowchart|graph)\s+(TD|TB|LR|RL)\b/i);
  if (!headerMatch) return null;

  const rawDir = headerMatch[1].toUpperCase();
  const direction: 'TD' | 'LR' = rawDir === 'LR' || rawDir === 'RL' ? 'LR' : 'TD';
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];

  for (const line of lines.slice(1)) {
    if (/^(?:subgraph|end|style|classDef|class|click)\b/i.test(line)) continue;

    const edgeMatch = line.match(
      /^(.+?)\s*(?:-->|==>|-\.->)\s*(?:\|([^|]+)\|\s*)?(.+)$/,
    );
    if (edgeMatch) {
      const fromId = upsertTokenNode(nodes, edgeMatch[1]);
      const toId = upsertTokenNode(nodes, edgeMatch[3]);
      if (fromId && toId) {
        edges.push({
          from: fromId,
          to: toId,
          label: edgeMatch[2] ? cleanMermaidLabel(edgeMatch[2]) : undefined,
        });
      }
      continue;
    }

    upsertTokenNode(nodes, line);
  }

  if (nodes.size < 2 || edges.length === 0) return null;
  return { direction, nodes, edges };
}

export function resolveRelativeRepoTarget(
  href: string,
  currentDestination: string,
): { repoPath: string; hash: string } | null {
  const trimmed = (href || '').trim();
  if (!trimmed || /^(?:https?:|mailto:|tel:|data:|#)/i.test(trimmed)) {
    return null;
  }
  const hashIdx = trimmed.indexOf('#');
  const rawPath = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
  const hash = hashIdx >= 0 ? trimmed.slice(hashIdx) : '';
  const cleanCurrent = (currentDestination || '').replace(/^\/+/, '');
  const baseParts = cleanCurrent.includes('/')
    ? cleanCurrent.split('/').slice(0, -1)
    : [];
  const resolved: string[] = [...baseParts];
  for (const seg of rawPath.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      resolved.pop();
    } else {
      resolved.push(seg);
    }
  }
  const repoPath = resolved.join('/');
  return repoPath ? { repoPath, hash } : null;
}

export function extractGitHubRepoSlug(repositoryUrl?: string): string | null {
  const cleaned = (repositoryUrl || '').trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  const match = cleaned.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)$/i);
  return match ? match[1] : null;
}

function stripInlineMarkdownFormatting(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .trim();
}

export function extractArticleTitle(markdown: string, fallbackTitle: string): string {
  const trimmed = (markdown || '').replace(/\r\n/g, '\n').trim();
  const h1Match = trimmed.match(/^#\s+([^\n]+)/);
  if (h1Match?.[1]) {
    const cleaned = stripInlineMarkdownFormatting(h1Match[1]);
    if (cleaned) return cleaned;
  }
  const htmlH1Match = trimmed.match(/^<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (htmlH1Match?.[1]) {
    const cleaned = stripInlineMarkdownFormatting(htmlH1Match[1].replace(/<[^>]+>/g, ''));
    if (cleaned) return cleaned;
  }
  return fallbackTitle.trim();
}

function formatMermaidAsBlockquote(code: string): string | null {
  const parsed = parseMermaidFlowchart(code);
  if (!parsed) return null;

  const isEnglish = !/[\p{Script=Han}]/u.test(code);
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

  const lines: string[] = [
    `> **${isEnglish ? 'Workflow Overview' : '步骤一览'}**`,
    '>',
  ];

  orderedIds.forEach((id, idx) => {
    const node = parsed.nodes.get(id)!;
    const branchLabels = incomingLabelByNode.get(id);
    const branchPrefix = branchLabels?.length ? `[${branchLabels.join(' / ')}] ` : '';
    lines.push(`> ${idx + 1}. ${branchPrefix}**${node.label}**`);
  });

  if (loopEdges.length > 0) {
    lines.push('>');
    for (const loop of loopEdges) {
      const targetStep = (orderIndex.get(loop.to) ?? 0) + 1;
      const targetNode = parsed.nodes.get(loop.to);
      if (isEnglish) {
        lines.push(
          `> - ↩ ${loop.label ? `${loop.label}: ` : 'Loop: '}back to Step ${targetStep}${targetNode ? ` (${targetNode.label})` : ''}`,
        );
      } else {
        lines.push(
          `> - ↩ ${loop.label ? `${loop.label}：` : '循环：'}回到第 ${targetStep} 步${targetNode ? `（${targetNode.label}）` : ''}`,
        );
      }
    }
  }

  return lines.join('\n');
}

function extractHtmlImgTagAttrs(rawTag: string): { src: string; alt: string } | null {
  const srcMatch = rawTag.match(/\bsrc=["']([^"']+)["']/i);
  const src = srcMatch?.[1]?.trim();
  if (!src || /^(?:javascript:)/i.test(src)) return null;
  const altMatch = rawTag.match(/\balt=["']([^"']*)["']/i);
  return { src, alt: altMatch?.[1]?.trim() || '' };
}

export function buildExternalMarkdown(options: ExternalExportOptions): string {
  const branch = (options.branch || 'main').trim() || 'main';
  const stripLeadingH1 = options.stripLeadingH1 ?? true;
  const convertMermaidToSteps = options.convertMermaidToSteps ?? false;
  const repoSlug = extractGitHubRepoSlug(options.repositoryUrl);

  let text = (options.markdown || '').replace(/\r\n/g, '\n');
  if (stripLeadingH1) {
    text = text.replace(/^\s*#\s+[^\n]+(?:\n+|$)/, '');
  }

  const resolveImageUrl = (rawSrc: string): string => {
    const trimmed = (rawSrc || '').trim();
    if (!trimmed || /^(?:https?:|data:|blob:)/i.test(trimmed)) return trimmed;
    if (repoSlug) {
      const rel = resolveRelativeRepoTarget(trimmed, options.destination);
      if (rel) {
        return `https://raw.githubusercontent.com/${repoSlug}/${branch}/${rel.repoPath}`;
      }
    }
    return trimmed;
  };

  const resolveDocUrl = (rawHref: string): string => {
    const trimmed = (rawHref || '').trim();
    if (!trimmed || /^(?:https?:|mailto:|tel:|data:|#)/i.test(trimmed)) return trimmed;
    if (repoSlug) {
      const rel = resolveRelativeRepoTarget(trimmed, options.destination);
      if (rel) {
        return `https://github.com/${repoSlug}/blob/${branch}/${rel.repoPath}${rel.hash}`;
      }
    }
    return trimmed;
  };

  return text
    .split(/(```[^\n]*\n[\s\S]*?\n```)/g)
    .map((segment, idx) => {
      if (idx % 2 === 1) {
        if (convertMermaidToSteps) {
          const fenceMatch = segment.match(/^```([A-Za-z0-9_-]*)\n([\s\S]*?)\n```$/);
          if (fenceMatch && fenceMatch[1].toLowerCase() === 'mermaid') {
            const blockquote = formatMermaidAsBlockquote(fenceMatch[2]);
            if (blockquote) return `\n\n${blockquote}\n\n`;
          }
        }
        return `\n\n${segment.trim()}\n\n`;
      }

      const codeSlots: string[] = [];
      let out = segment.replace(/`[^`\n]+`/g, (match) => {
        const placeholder = `\u0000EXTCODE${codeSlots.length}\u0000`;
        codeSlots.push(match);
        return placeholder;
      });

      out = out.replace(/<img\b[^>]*>/gi, (tag) => {
        const parsed = extractHtmlImgTagAttrs(tag);
        return parsed ? `![${parsed.alt}](${resolveImageUrl(parsed.src)})` : '';
      });

      out = out.replace(
        /!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g,
        (_m, alt: string, rawSrc: string, titlePart = '') =>
          `![${alt}](${resolveImageUrl(rawSrc)}${titlePart})`,
      );

      out = out.replace(
        /(?<!!)\[([^\]]+)\]\(([^)\s]+)(\s+"[^"]*")?\)/g,
        (_m, label: string, rawHref: string, titlePart = '') =>
          `[${label}](${resolveDocUrl(rawHref)}${titlePart})`,
      );

      out = out.replace(/\*\*(https?:\/\/[^\s*)]+)\*\*/g, '**[$1]($1)**');

      out = out.replace(/\u0000EXTCODE(\d+)\u0000/g, (_m, n) => codeSlots[Number(n)] ?? '');
      return out;
    })
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBasicTextHtml(raw: string): string {
  return escapeHtml(raw)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
}

function formatInlineHtml(text: string): string {
  const codeSlots: string[] = [];
  const tokenSlots: string[] = [];

  let work = text.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const token = `\u0000HTMLCODE${codeSlots.length}\u0000`;
    codeSlots.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  work = work.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_m, alt: string, url: string) => {
      const token = `\u0000HTMLTOK${tokenSlots.length}\u0000`;
      tokenSlots.push(`<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" />`);
      return token;
    },
  );

  work = work.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_m, label: string, url: string) => {
      const token = `\u0000HTMLTOK${tokenSlots.length}\u0000`;
      const innerLabel = formatBasicTextHtml(label).replace(
        /\u0000HTMLCODE(\d+)\u0000/g,
        (_cm, n) => codeSlots[Number(n)] ?? '',
      );
      tokenSlots.push(`<a href="${escapeHtml(url)}">${innerLabel}</a>`);
      return token;
    },
  );

  let html = formatBasicTextHtml(work);
  html = html.replace(/\u0000HTMLTOK(\d+)\u0000/g, (_m, n) => tokenSlots[Number(n)] ?? '');
  html = html.replace(/\u0000HTMLCODE(\d+)\u0000/g, (_m, n) => codeSlots[Number(n)] ?? '');
  return html;
}

function splitGfmTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
}

function isBlockStarter(line: string, nextLine?: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^```/.test(trimmed)) return true;
  if (/^#{1,4}\s+/.test(trimmed)) return true;
  if (/^>/.test(trimmed)) return true;
  if (/^(?:---|\*\*\*|___)\s*$/.test(trimmed)) return true;
  if (/^\s*[-*]\s+/.test(line)) return true;
  if (/^\s*\d+\.\s+/.test(line)) return true;
  if (/^!\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\)\s*$/.test(trimmed)) return true;
  if (
    trimmed.includes('|') &&
    nextLine !== undefined &&
    /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(nextLine)
  ) {
    return true;
  }
  return false;
}

function blocksToHtml(markdownText: string): string {
  const lines = markdownText.replace(/\r\n/g, '\n').split('\n');
  const htmlBlocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    if (/^```/.test(trimmed)) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length && /^```\s*$/.test(lines[i].trim())) i += 1;
      htmlBlocks.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      htmlBlocks.push(`<h${level}>${formatInlineHtml(headingMatch[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^(?:---|\*\*\*|___)\s*$/.test(trimmed)) {
      htmlBlocks.push('<hr />');
      i += 1;
      continue;
    }

    if (/^>/.test(trimmed)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>/.test(lines[i].trim())) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      htmlBlocks.push(`<blockquote>${blocksToHtml(quoteLines.join('\n'))}</blockquote>`);
      continue;
    }

    if (
      trimmed.includes('|') &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])
    ) {
      const headers = splitGfmTableRow(lines[i]);
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        bodyRows.push(splitGfmTableRow(lines[i]));
        i += 1;
      }
      const headHtml = `<thead><tr>${headers.map((h) => `<th>${formatInlineHtml(h)}</th>`).join('')}</tr></thead>`;
      const bodyHtml =
        bodyRows.length > 0
          ? `<tbody>${bodyRows
              .map((row) => `<tr>${row.map((cell) => `<td>${formatInlineHtml(cell)}</td>`).join('')}</tr>`)
              .join('')}</tbody>`
          : '';
      htmlBlocks.push(`<table>${headHtml}${bodyHtml}</table>`);
      continue;
    }

    const standaloneImgMatch = trimmed.match(
      /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/,
    );
    if (standaloneImgMatch) {
      const imgTag = `<img src="${escapeHtml(standaloneImgMatch[2])}" alt="${escapeHtml(standaloneImgMatch[1])}" />`;
      let lookAhead = i + 1;
      while (lookAhead < lines.length && !lines[lookAhead].trim()) {
        lookAhead += 1;
      }
      const nextTrimmed = lookAhead < lines.length ? lines[lookAhead].trim() : '';
      const captionMatch = nextTrimmed.match(/^\*([^*\n]+)\*$/);
      const afterCaptionBlankOrEof =
        lookAhead + 1 >= lines.length || !lines[lookAhead + 1].trim();
      if (captionMatch && afterCaptionBlankOrEof) {
        htmlBlocks.push(
          `<figure>${imgTag}<figcaption><em>${formatInlineHtml(captionMatch[1])}</em></figcaption></figure>`,
        );
        i = lookAhead + 1;
      } else {
        htmlBlocks.push(`<figure>${imgTag}</figure>`);
        i += 1;
      }
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, '').trim());
        i += 1;
      }
      htmlBlocks.push(`<ul>${items.map((item) => `<li>${formatInlineHtml(item)}</li>`).join('')}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, '').trim());
        i += 1;
      }
      htmlBlocks.push(`<ol>${items.map((item) => `<li>${formatInlineHtml(item)}</li>`).join('')}</ol>`);
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isBlockStarter(lines[i], lines[i + 1])
    ) {
      paraLines.push(lines[i].trim());
      i += 1;
    }
    if (paraLines.length > 0) {
      htmlBlocks.push(`<p>${formatInlineHtml(paraLines.join(' '))}</p>`);
    } else {
      i += 1;
    }
  }

  return htmlBlocks.join('\n');
}

export function buildExternalRichHtml(options: ExternalExportOptions): string {
  const externalMd = buildExternalMarkdown({ ...options, convertMermaidToSteps: true });
  return blocksToHtml(externalMd);
}

/** Writes rich HTML + plain Markdown fallback to the system clipboard when ClipboardItem is available. */
export async function copyRichHtmlToClipboard(html: string, plainText: string): Promise<void> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    const item = new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([plainText], { type: 'text/plain' }),
    });
    await navigator.clipboard.write([item]);
    return;
  }
  await navigator.clipboard.writeText(plainText);
}


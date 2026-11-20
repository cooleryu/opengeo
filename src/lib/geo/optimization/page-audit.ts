import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { z } from 'zod';
import {
  defaultAgentHub,
  type AgentSpec,
  type HumanProgressStep,
  type LLMTransport,
} from '../../agent-hub';
import { readAgentText } from '../agent-files';
import { resolveAssetOwnership } from '../asset-ownership';
import {
  createProjectInspectionTools,
  isSelfWorkspaceRepo,
  readAnswerTextFromFile,
  resolveLocalRepoFileForAsset,
  resolveOwnedAssetContent,
} from '../agents/project-tools';
import { ensureProjectRelationalData, parseSourcesJson, withProjectDb } from '../db';
import { resolveProjectTargetLanguage, resolveProjectUiLanguage } from '../i18n';
import { readProjectContext } from '../project-context';
import { loadProjectSeed } from '../project-data';
import { evidenceLocation, projectDataDirectory, withGeoProject } from '../projects';
import type { GeoAsset } from '../types';
import { parseGitHubRepoSlug, pushEditsToProjectRepo, resolveRepoRelativeDocPath, type PublishGitHubOptions } from './git-publisher';
import { OptimizationStateError } from './repository';

export type PageAuditEngine = 'chatgpt' | 'google';
export type PageAuditFindingCategory =
  | 'missing_definition'
  | 'competitor_angle_gap'
  | 'answer_coverage_gap'
  | 'weak_claim_check';

export interface PageSection {
  id: string;
  heading: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface AnswerShardItem {
  questionId: string;
  engine: PageAuditEngine;
  query: string;
  mention: string;
  citation: string;
  answerText: string;
  sources: Array<{ title: string; url: string }>;
}

export interface AnswerShardInput {
  engine: PageAuditEngine;
  shardIndex: number;
  shardTotal: number;
  uiLanguage: 'en' | 'zh';
  projectName: string;
  items: AnswerShardItem[];
}

export const answerSignalShardSchema = z.object({
  engine: z.enum(['chatgpt', 'google']),
  categoryLabels: z.array(z.string().min(1)).max(8),
  competitorAngles: z
    .array(
      z.object({
        competitor: z.string().min(1),
        praisedFor: z.string().min(1),
      }),
    )
    .max(8),
  buyerCriteria: z.array(z.string().min(1)).max(6),
  projectPerception: z.string().min(1),
});

export type AnswerSignalShard = z.infer<typeof answerSignalShardSchema>;

export const answerSignalSheetSchema = z.object({
  dominantCategory: z.string().min(1),
  platformDifferences: z.object({
    chatgpt: z.string().min(1),
    google: z.string().min(1),
  }),
  topCompetitorAngles: z
    .array(
      z.object({
        dimension: z.string().min(1),
        competitors: z.array(z.string().min(1)).max(5),
        engines: z.array(z.enum(['chatgpt', 'google'])).min(1),
      }),
    )
    .max(6),
  mustAnswerCriteria: z.array(z.string().min(1)).max(6),
  summary: z.string().min(1),
});

export type AnswerSignalSheet = z.infer<typeof answerSignalSheetSchema>;

const rawFindingSchema = z.object({
  category: z.enum([
    'missing_definition',
    'competitor_angle_gap',
    'answer_coverage_gap',
    'weak_claim_check',
  ]),
  impact: z.enum(['high', 'medium']),
  sectionId: z.string().min(1),
  anchorQuote: z.string().min(1),
  title: z.string().min(4).max(160),
  whyAiMissed: z.string().min(8).max(600),
  citedEngines: z.array(z.enum(['chatgpt', 'google'])).min(1),
  codebaseFact: z.string().min(4).max(500),
  suggestedDirection: z.string().min(8).max(500),
});

export const pageSectionAuditOutputSchema = z.object({
  findings: z.array(rawFindingSchema).min(1).max(5),
});

export type PageSectionAuditOutput = z.infer<typeof pageSectionAuditOutputSchema>;

export const surgicalPatchOutputSchema = z.object({
  insertionMode: z.enum(['replace', 'insert_after']),
  beforeExcerpt: z.string().min(4).max(2500),
  afterExcerpt: z.string().min(8).max(3500),
  plainSummary: z.string().min(6).max(320),
});

export type SurgicalPatchOutput = z.infer<typeof surgicalPatchOutputSchema>;

export interface SurgicalPatchPreview extends SurgicalPatchOutput {
  unifiedDiff: string;
  generatedAt: string;
  model?: string;
}

export interface PageAuditFinding {
  id: string;
  category: PageAuditFindingCategory;
  impact: 'high' | 'medium';
  sectionId: string;
  sectionHeading: string;
  startLine: number;
  endLine: number;
  sectionExcerpt: string;
  anchorQuote: string;
  screenshotFile?: string;
  title: string;
  whyAiMissed: string;
  citedEngines: PageAuditEngine[];
  codebaseFact: string;
  suggestedDirection: string;
  status: 'open' | 'applied' | 'dismissed';
  patchPreview?: SurgicalPatchPreview;
  appliedAt?: string;
}

export interface PageAuditShippedRecord {
  id: string;
  targetLabel: string;
  liveUrl: string;
  findingIds: string[];
  findingTitles: string[];
  shippedAt: string;
  note?: string;
}

export interface PageAuditRecord {
  id: string;
  projectId: string;
  targetAssetId: string;
  targetLabel: string;
  targetUrl?: string | null;
  localFilePath?: string | null;
  targetKind: 'repo_doc' | 'live_web';
  targetLanguage: 'en' | 'zh';
  uiLanguage: 'en' | 'zh';
  shardStats: {
    totalAnswers: number;
    chatgptAnswers: number;
    googleAnswers: number;
    shardCount: number;
  };
  signalSheet: AnswerSignalSheet;
  findings: PageAuditFinding[];
  progress: HumanProgressStep[];
  shippedRecords?: PageAuditShippedRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface PageAuditTargetOption {
  assetId: string;
  label: string;
  targetKind: 'repo_doc' | 'live_web';
  publicUrl?: string | null;
  localFilePath?: string | null;
}

interface PageAuditStorePayload {
  version: 1;
  latest: PageAuditRecord | null;
}

/** Parses Markdown or plain page snapshots into clean numbered sections with 1-based line spans. */
export function parsePageSections(rawContent: string, isEn = false): PageSection[] {
  const normalized = rawContent.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (!lines.length || !normalized.trim()) return [];

  const boundaries: Array<{ heading: string; startIdx: number }> = [];
  let inFence = false;
  let firstH1 = '';

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!firstH1 && /^#\s+(.+)$/.test(line.trim())) {
      firstH1 = line.trim().replace(/^#\s+/, '').trim();
      continue;
    }
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      boundaries.push({ heading: h2[1].trim(), startIdx: i });
    }
  }

  const sections: PageSection[] = [];
  if (boundaries.length > 0) {
    if (boundaries[0].startIdx > 0) {
      const introLines = lines.slice(0, boundaries[0].startIdx);
      if (introLines.join('\n').trim()) {
        sections.push({
          id: 'S0',
          heading: firstH1
            ? isEn
              ? `Opening / ${firstH1}`
              : `顶部介绍 · ${firstH1}`
            : isEn
              ? 'Opening / Hero'
              : '顶部介绍区',
          startLine: 1,
          endLine: boundaries[0].startIdx,
          content: introLines.join('\n').trimEnd(),
        });
      }
    }

    for (let b = 0; b < boundaries.length; b += 1) {
      const startIdx = boundaries[b].startIdx;
      const endIdx = b + 1 < boundaries.length ? boundaries[b + 1].startIdx - 1 : lines.length - 1;
      const chunk = lines.slice(startIdx, endIdx + 1).join('\n').trimEnd();
      if (!chunk.trim()) continue;
      sections.push({
        id: `S${sections.length}`,
        heading: boundaries[b].heading,
        startLine: startIdx + 1,
        endLine: endIdx + 1,
        content: chunk,
      });
    }
    return sections;
  }

  // Fallback for pages without H2 headings: chunk cleanly by paragraph groups (~28 lines each)
  const chunkSize = 28;
  let cursor = 0;
  while (cursor < lines.length) {
    let end = Math.min(lines.length - 1, cursor + chunkSize - 1);
    if (end < lines.length - 1) {
      for (let look = end; look > cursor + 10; look -= 1) {
        if (!lines[look].trim()) {
          end = look;
          break;
        }
      }
    }
    const chunk = lines.slice(cursor, end + 1).join('\n').trimEnd();
    if (chunk.trim()) {
      const firstTextLine =
        chunk
          .split('\n')
          .map((l) => l.replace(/^#+\s*/, '').trim())
          .find(Boolean) ?? '';
      sections.push({
        id: `S${sections.length}`,
        heading:
          sections.length === 0
            ? isEn
              ? 'Opening / Hero'
              : '页面首屏区'
            : firstTextLine.slice(0, 42) || (isEn ? `Section ${sections.length + 1}` : `第 ${sections.length + 1} 区块`),
        startLine: cursor + 1,
        endLine: end + 1,
        content: chunk,
      });
    }
    cursor = end + 1;
  }

  return sections;
}

/** Splits full captured AI answers strictly by engine into balanced parallel Map shards. */
export function buildEngineAnswerShards(
  items: AnswerShardItem[],
  options: { maxPerShard?: number; uiLanguage: 'en' | 'zh'; projectName: string },
): AnswerShardInput[] {
  const maxPerShard = Math.max(1, options.maxPerShard ?? 4);
  const shards: AnswerShardInput[] = [];

  for (const engine of ['chatgpt', 'google'] as const) {
    const bucket = items.filter((item) => item.engine === engine && item.answerText.trim().length > 0);
    if (!bucket.length) continue;
    const shardCount = Math.ceil(bucket.length / maxPerShard);
    const perShard = Math.ceil(bucket.length / shardCount);
    for (let i = 0; i < shardCount; i += 1) {
      const slice = bucket.slice(i * perShard, (i + 1) * perShard).map((entry) => ({
        ...entry,
        answerText: entry.answerText.slice(0, 3_200),
        sources: entry.sources.slice(0, 6),
      }));
      if (!slice.length) continue;
      shards.push({
        engine,
        shardIndex: i + 1,
        shardTotal: shardCount,
        uiLanguage: options.uiLanguage,
        projectName: options.projectName,
        items: slice,
      });
    }
  }

  return shards;
}

/** Computes a compact, human-inspectable unified diff for the collapsed technical drawer. */
export function computeCompactUnifiedDiff(
  beforeText: string,
  afterText: string,
  startLineHint = 1,
): string {
  const beforeLines = beforeText.replace(/\r\n/g, '\n').split('\n');
  const afterLines = afterText.replace(/\r\n/g, '\n').split('\n');

  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const ctxBefore = beforeLines.slice(Math.max(0, prefix - 2), prefix);
  const removed = beforeLines.slice(prefix, beforeLines.length - suffix);
  const added = afterLines.slice(prefix, afterLines.length - suffix);
  const ctxAfter = beforeLines.slice(
    beforeLines.length - suffix,
    Math.min(beforeLines.length, beforeLines.length - suffix + 2),
  );

  const lineStart = Math.max(1, startLineHint + Math.max(0, prefix - 2));
  const out: string[] = [
    `@@ -${lineStart},${ctxBefore.length + removed.length + ctxAfter.length} +${lineStart},${ctxBefore.length + added.length + ctxAfter.length} @@`,
  ];
  for (const line of ctxBefore) out.push(`  ${line}`);
  for (const line of removed) out.push(`- ${line}`);
  for (const line of added) out.push(`+ ${line}`);
  for (const line of ctxAfter) out.push(`  ${line}`);
  return out.join('\n');
}

// Rows added after a table row, or items after a list item, continue that block: a blank
// line between them would split the table or list. Anything else starts a new block.
const TABLE_ROW = /^\s*\|/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
function insertSeparator(matched: string, inserted: string, tail: string): string {
  const last = matched.split('\n').pop() ?? '';
  const first = inserted.split('\n')[0] ?? '';
  const atLineEnd = tail === '' || tail.startsWith('\n');
  const sameBlock = (TABLE_ROW.test(last) && TABLE_ROW.test(first)) || (LIST_ITEM.test(last) && LIST_ITEM.test(first));
  return atLineEnd && sameBlock ? '\n' : '\n\n';
}

/** Deterministically applies a surgical section patch without disturbing any other line. */
export function applySurgicalPatchToContent(
  fullContent: string,
  patch: Pick<SurgicalPatchOutput, 'insertionMode' | 'beforeExcerpt' | 'afterExcerpt'>,
): { patchedContent: string; matchedIndex: number } {
  const normalizedFull = fullContent.replace(/\r\n/g, '\n');
  const normalizedBefore = patch.beforeExcerpt.replace(/\r\n/g, '\n').trim();
  const normalizedAfter = patch.afterExcerpt.replace(/\r\n/g, '\n').trim();

  if (!normalizedBefore) {
    throw new Error('缺少可定位的原文锚点片段，无法安全应用局部修改。');
  }

  let idx = normalizedFull.indexOf(normalizedBefore);
  let matchLen = normalizedBefore.length;

  if (idx < 0) {
    // Tolerant line-trimmed fallback so minor trailing spaces do not block safe patching
    const needleLines = normalizedBefore.split('\n').map((l) => l.trim());
    const hayLines = normalizedFull.split('\n');
    for (let i = 0; i <= hayLines.length - needleLines.length; i += 1) {
      let ok = true;
      for (let j = 0; j < needleLines.length; j += 1) {
        if (hayLines[i + j].trim() !== needleLines[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        const prefixText = hayLines.slice(0, i).join('\n');
        const matchedText = hayLines.slice(i, i + needleLines.length).join('\n');
        idx = i === 0 ? 0 : prefixText.length + 1;
        matchLen = matchedText.length;
        break;
      }
    }
  }

  if (idx < 0) {
    throw new Error('目标文件该区块内容已发生变化，未找到原定位片段；请重新生成预览后再应用。');
  }

  const head = normalizedFull.slice(0, idx);
  const matched = normalizedFull.slice(idx, idx + matchLen);
  const tail = normalizedFull.slice(idx + matchLen);

  const patchedContent =
    patch.insertionMode === 'insert_after'
      ? `${head}${matched}${insertSeparator(matched, normalizedAfter, tail)}${normalizedAfter}${tail}`
      : `${head}${normalizedAfter}${tail}`;

  return { patchedContent, matchedIndex: idx };
}

function buildSectionExcerpt(section: PageSection, anchorQuote: string): { excerpt: string; anchor: string } {
  const text = section.content.trim();
  const cleanAnchor = anchorQuote.trim();
  if (cleanAnchor && text.includes(cleanAnchor)) {
    const idx = text.indexOf(cleanAnchor);
    const start = Math.max(0, idx - 120);
    const end = Math.min(text.length, idx + cleanAnchor.length + 160);
    const slice = text.slice(start, end).trim();
    return {
      excerpt: `${start > 0 ? '…' : ''}${slice}${end < text.length ? '…' : ''}`,
      anchor: cleanAnchor,
    };
  }
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const fallbackAnchor = lines.find((l) => !l.startsWith('#') && !l.startsWith('![') && l.length >= 16) ?? lines[0] ?? '';
  return {
    excerpt: text.slice(0, 420) + (text.length > 420 ? '…' : ''),
    anchor: fallbackAnchor.slice(0, 140),
  };
}

/** Registered AgentHub Strategy 1: Parallel Map Worker reading one engine shard of full answers. */
export const answerSignalMapperAgent: AgentSpec<AnswerShardInput, AnswerSignalShard> = {
  id: 'answer-signal-mapper',
  title: '实测回答分片提纯官',
  role: 'fast',
  maxTurns: 2,
  temperature: 0.1,
  outputSchema: answerSignalShardSchema,
  buildPrompt(input) {
    const system = readAgentText('improvement-planning', 'page-audit-mapper.md');
    return {
      system: `${system}\n\n输出语言（uiLanguage）：${input.uiLanguage === 'en' ? 'English' : '简体中文'}。`,
      user: JSON.stringify(
        {
          engine: input.engine,
          shard: `${input.shardIndex}/${input.shardTotal}`,
          targetProject: input.projectName,
          answers: input.items,
        },
        null,
        2,
      ),
    };
  },
};

export interface AnswerSignalReducerInput {
  projectName: string;
  uiLanguage: 'en' | 'zh';
  shards: AnswerSignalShard[];
}

/** Registered AgentHub Strategy 2: Reduce Synthesizer combining ChatGPT & Google shards. */
export const answerSignalReducerAgent: AgentSpec<AnswerSignalReducerInput, AnswerSignalSheet> = {
  id: 'answer-signal-reducer',
  title: '跨平台回答信号汇总官',
  role: 'fast',
  maxTurns: 2,
  temperature: 0.1,
  outputSchema: answerSignalSheetSchema,
  buildPrompt(input) {
    const system = readAgentText('improvement-planning', 'page-audit-reducer.md');
    return {
      system: `${system}\n\n输出语言（uiLanguage）：${input.uiLanguage === 'en' ? 'English' : '简体中文'}。`,
      user: JSON.stringify(input, null, 2),
    };
  },
};

export interface PageSectionAuditorInput {
  targetLabel: string;
  targetKind: 'repo_doc' | 'live_web';
  targetLanguage: 'en' | 'zh';
  uiLanguage: 'en' | 'zh';
  signalSheet: AnswerSignalSheet;
  sections: Array<{
    id: string;
    heading: string;
    startLine: number;
    endLine: number;
    content: string;
  }>;
}

/** Registered AgentHub Strategy 3: Section-level Page Auditor with local codebase fact checking. */
export const pageSectionAuditorAgent: AgentSpec<PageSectionAuditorInput, PageSectionAuditOutput> = {
  id: 'page-section-auditor',
  title: '页面分块活页体检官',
  role: 'default',
  maxTurns: 6,
  temperature: 0.15,
  outputSchema: pageSectionAuditOutputSchema,
  tools: (input) => {
    const allTools = createProjectInspectionTools({ targetLanguage: input.targetLanguage });
    return allTools.filter(
      (tool) =>
        tool.name === 'read_project_context' ||
        tool.name === 'read_workspace_file' ||
        tool.name === 'list_project_media',
    );
  },
  buildPrompt(input, ctx) {
    const seed = loadProjectSeed(ctx.projectId);
    const projectContext = readProjectContext(ctx.projectId).markdown;
    const system = readAgentText('improvement-planning', 'page-section-auditor.md');
    const hasLocalWorkspace = isSelfWorkspaceRepo(seed);
    const verificationDirective = hasLocalWorkspace
      ? '当前为本地代码仓库：最多用 1 轮调用 read_workspace_file 查看 package.json / LICENSE 等关键文件核实真实能力与协议。'
      : '当前为纯公开网站（无本地代码仓库）：严禁假设 GitHub 仓库或 package.json 存在，事实核实严格依据输入中的 projectContextSummary、项目描述与页面原文。';
    return {
      system: `${system}\n\n输出语言（uiLanguage）：${input.uiLanguage === 'en' ? 'English' : '简体中文'}。\n${verificationDirective}`,
      user: JSON.stringify(
        {
          project: {
            name: seed.project.name,
            description: seed.project.description,
            repositoryUrl: seed.project.repositoryUrl,
            siteUrl: seed.project.siteUrl,
            hasLocalWorkspace,
          },
          targetPage: {
            label: input.targetLabel,
            kind: input.targetKind,
            targetLanguage: input.targetLanguage,
          },
          projectContextSummary: projectContext.slice(0, 3_500),
          aiAnswerSignalSheet: input.signalSheet,
          sections: input.sections.map((s) => ({
            id: s.id,
            heading: s.heading,
            lines: `${s.startLine}-${s.endLine}`,
            content: s.content.slice(0, 2_200),
          })),
        },
        null,
        2,
      ),
    };
  },
  validate(output, input) {
    const validIds = new Set(input.sections.map((s) => s.id));
    for (const f of output.findings) {
      if (!validIds.has(f.sectionId)) {
        return `finding 的 sectionId "${f.sectionId}" 不在允许列表 [${[...validIds].join(', ')}] 中。`;
      }
    }
    const weakClaims = output.findings.filter((f) => f.category === 'weak_claim_check');
    if (weakClaims.length > 1) {
      return 'weak_claim_check 属于克制加分项，最多只允许输出 1 条。';
    }
    return null;
  },
};

export interface SectionPatcherInput {
  targetLabel: string;
  targetLanguage: 'en' | 'zh';
  uiLanguage: 'en' | 'zh';
  finding: PageAuditFinding;
  section: PageSection;
}

/** Registered AgentHub Strategy 4: On-demand Single-Section Surgical Patcher. */
export const sectionSurgicalPatcherAgent: AgentSpec<SectionPatcherInput, SurgicalPatchOutput> = {
  id: 'section-surgical-patcher',
  title: '单区块手术刀改稿官',
  role: 'default',
  maxTurns: 3,
  temperature: 0.2,
  outputSchema: surgicalPatchOutputSchema,
  buildPrompt(input, ctx) {
    const projectContext = readProjectContext(ctx.projectId).markdown;
    const system = readAgentText('improvement-planning', 'section-surgical-patcher.md');
    return {
      system: `${system}\n\n成稿语言（afterExcerpt）：${input.targetLanguage === 'en' ? '地道自然 English' : '平实自然简体中文'}。\n人话摘要语言（plainSummary）：${input.uiLanguage === 'en' ? 'English' : '简体中文'}。`,
      user: JSON.stringify(
        {
          targetLabel: input.targetLabel,
          finding: {
            category: input.finding.category,
            title: input.finding.title,
            whyAiMissed: input.finding.whyAiMissed,
            codebaseFact: input.finding.codebaseFact,
            suggestedDirection: input.finding.suggestedDirection,
            anchorQuote: input.finding.anchorQuote,
          },
          section: {
            id: input.section.id,
            heading: input.section.heading,
            lines: `${input.section.startLine}-${input.section.endLine}`,
            content: input.section.content,
          },
          projectContextExcerpt: projectContext.slice(0, 2_500),
        },
        null,
        2,
      ),
    };
  },
  validate(output, input) {
    const hay = input.section.content.replace(/\r\n/g, '\n');
    const needle = output.beforeExcerpt.replace(/\r\n/g, '\n').trim();
    if (!needle) return 'beforeExcerpt 不能为空。';
    if (!hay.includes(needle)) {
      const needleLines = needle.split('\n').map((l) => l.trim());
      const hayLines = hay.split('\n').map((l) => l.trim());
      let found = false;
      for (let i = 0; i <= hayLines.length - needleLines.length; i += 1) {
        if (needleLines.every((nl, j) => hayLines[i + j] === nl)) {
          found = true;
          break;
        }
      }
      if (!found) {
        return 'beforeExcerpt 必须逐字取自输入 section.content，以便安全精确替换。';
      }
    }
    return null;
  },
};

// Register all 4 strategies on the shared AgentHub singleton immediately
defaultAgentHub
  .register(answerSignalMapperAgent)
  .register(answerSignalReducerAgent)
  .register(pageSectionAuditorAgent)
  .register(sectionSurgicalPatcherAgent);

function auditFilePath(): string {
  return path.join(projectDataDirectory(), 'page-audit.json');
}

export function auditShotsDirectory(projectId: string): string {
  return withGeoProject(projectId, () => path.join(projectDataDirectory(), 'audit-shots'));
}

export function readLatestPageAudit(projectId: string): PageAuditRecord | null {
  return withGeoProject(projectId, () => {
    const file = auditFilePath();
    if (!fs.existsSync(file)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<PageAuditStorePayload>;
      return raw.latest ?? null;
    } catch {
      return null;
    }
  });
}

function saveLatestPageAudit(projectId: string, record: PageAuditRecord): PageAuditRecord {
  return withGeoProject(projectId, () => {
    const file = auditFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ version: 1, latest: record } satisfies PageAuditStorePayload, null, 2),
      'utf8',
    );
    fs.renameSync(tmp, file);
    return record;
  });
}

function isPublicRenderableUrl(url?: string | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    return host !== 'raw.githubusercontent.com';
  } catch {
    return false;
  }
}

function isLiveWebUrl(url?: string | null): boolean {
  if (!isPublicRenderableUrl(url)) return false;
  try {
    const host = new URL(url!).hostname.toLowerCase().replace(/^www\./, '');
    return host !== 'github.com';
  } catch {
    return false;
  }
}

export const LIVE_SITE_HOME_ASSET_ID = '__site_home__';

function normalizeUrlStem(url?: string | null): string {
  if (!url) return '';
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
}

function formatPublicUrlLabel(url: string, fallback = ''): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('github.com')) {
      const m = parsed.pathname.match(/\/blob\/[^/]+\/(.+)$/);
      if (m) return decodeURIComponent(m[1]);
    }
    return `${parsed.hostname.replace(/^www\./i, '')}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return fallback || url;
  }
}

function formatAssetLabel(asset: GeoAsset, localRepoPath?: string | null): string {
  if (localRepoPath) {
    return path.relative(process.cwd(), localRepoPath).split(path.sep).join('/');
  }
  if (asset.publicUrl) {
    return formatPublicUrlLabel(asset.publicUrl, asset.title);
  }
  return asset.title;
}

/**
 * Deterministic HTML-to-structured-Markdown extractor for arbitrary public websites (SaaS / docs / landing pages).
 * Preserves H1–H3 section boundaries, paragraphs, list items, and tables so `parsePageSections` works identically to repo docs.
 */
export function extractStructuredMarkdownFromHtml(html: string, pageUrl: string): string {
  const dom = new JSDOM(html, { url: pageUrl });
  const doc = dom.window.document;

  doc
    .querySelectorAll('script, style, noscript, svg, iframe, template, [aria-hidden="true"]')
    .forEach((el) => el.remove());

  // Strip nav/cookie chrome outside main content if a clean <main> exists
  const mainEl = doc.querySelector('main') ?? doc.querySelector('article') ?? doc.body;
  if (!mainEl) return '';

  const blocks: string[] = [];
  const seen = new Set<string>();
  const pushBlock = (text: string) => {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (!cleaned || cleaned.length < 2) return;
    if (seen.has(cleaned.toLowerCase())) return;
    seen.add(cleaned.toLowerCase());
    blocks.push(cleaned);
  };

  const titleText = doc.title?.trim();
  const firstH1 = mainEl.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim();
  if (!firstH1 && titleText) {
    pushBlock(`# ${titleText}`);
  }

  const walk = (node: Element) => {
    const tag = node.tagName.toLowerCase();
    if (['nav', 'footer', 'aside', 'form', 'dialog', 'button'].includes(tag)) return;

    if (tag === 'h1') {
      const txt = node.textContent?.replace(/\s+/g, ' ').trim() || '';
      if (txt) pushBlock(`# ${txt}`);
      return;
    }
    if (tag === 'h2') {
      const txt = node.textContent?.replace(/\s+/g, ' ').trim() || '';
      if (txt) pushBlock(`## ${txt}`);
      return;
    }
    if (tag === 'h3') {
      const txt = node.textContent?.replace(/\s+/g, ' ').trim() || '';
      if (txt) pushBlock(`### ${txt}`);
      return;
    }
    if (tag === 'table') {
      const rows = Array.from(node.querySelectorAll('tr'))
        .map((tr) =>
          Array.from(tr.querySelectorAll('th, td'))
            .map((cell) => (cell.textContent || '').replace(/\s+/g, ' ').replace(/\|/g, '/').trim())
            .filter((cell, idx, arr) => cell.length > 0 || arr.some(Boolean)),
        )
        .filter((cells) => cells.length >= 2 && cells.some(Boolean));
      if (rows.length >= 2) {
        const colCount = Math.max(...rows.map((r) => r.length));
        const padRow = (r: string[]) =>
          `| ${Array.from({ length: colCount }, (_, i) => r[i] || '-').join(' | ')} |`;
        const tableLines = [
          padRow(rows[0]),
          `| ${Array.from({ length: colCount }, () => '---').join(' | ')} |`,
          ...rows.slice(1).map(padRow),
        ];
        blocks.push(tableLines.join('\n'));
      }
      return;
    }
    if (tag === 'p' || tag === 'blockquote' || tag === 'pre') {
      const txt = node.textContent?.replace(/\s+/g, ' ').trim() || '';
      if (txt.length >= 12) pushBlock(txt);
      return;
    }
    if (tag === 'li') {
      if (node.querySelector('p, h1, h2, h3, ul, ol')) {
        Array.from(node.children).forEach(walk);
        return;
      }
      const txt = node.textContent?.replace(/\s+/g, ' ').trim() || '';
      if (txt.length >= 8) pushBlock(`- ${txt}`);
      return;
    }

    const children = Array.from(node.children);
    if (children.length === 0) {
      const txt = node.textContent?.replace(/\s+/g, ' ').trim() || '';
      if (txt.length >= 24 && !['a', 'span', 'small', 'label'].includes(tag)) {
        pushBlock(txt);
      }
      return;
    }
    for (const child of children) {
      walk(child);
    }
  };

  walk(mainEl);
  return blocks.join('\n\n').slice(0, 28_000);
}

function liveSnapshotCachePath(projectId: string, url: string): string {
  const hash = createHash('sha256').update(url.trim()).digest('hex').slice(0, 16);
  return withGeoProject(projectId, () =>
    path.join(projectDataDirectory(), 'live-page-snapshots', `${hash}.md`),
  );
}

async function fetchLiveWebPageMarkdown(
  projectId: string,
  url: string,
  options?: { forceRefresh?: boolean; signal?: AbortSignal },
): Promise<string> {
  const cacheFile = liveSnapshotCachePath(projectId, url);
  if (!options?.forceRefresh && fs.existsSync(cacheFile)) {
    const stat = fs.statSync(cacheFile);
    if (Date.now() - stat.mtimeMs < 15 * 60_000) {
      const cached = fs.readFileSync(cacheFile, 'utf8').trim();
      if (cached.length >= 160) return cached;
    }
  }

  let extracted = '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    const onAbort = () => controller.abort();
    options?.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        },
      });
      if (res.ok) {
        const html = await res.text();
        extracted = extractStructuredMarkdownFromHtml(html, res.url || url);
      }
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener('abort', onAbort);
    }
  } catch {
    // Fall through to Playwright fallback for JS-rendered SPAs or strict endpoints
  }

  if (extracted.length < 240) {
    let browser: { close: () => Promise<void> } | null = null;
    try {
      const pw = await import('playwright');
      let launched: Awaited<ReturnType<typeof pw.chromium.launch>> | null = null;
      for (const launchOpts of [
        { headless: true },
        { headless: true, channel: 'chrome' as const },
        { headless: true, channel: 'msedge' as const },
      ]) {
        try {
          launched = await pw.chromium.launch(launchOpts);
          break;
        } catch {
          // Try next channel
        }
      }
      if (launched) {
        browser = launched;
        const page = await launched.newPage({ viewport: { width: 1280, height: 900 } });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 18_000 });
        await page.waitForTimeout(1000);
        const renderedHtml = await page.content();
        const pwExtracted = extractStructuredMarkdownFromHtml(renderedHtml, page.url() || url);
        if (pwExtracted.length > extracted.length) {
          extracted = pwExtracted;
        }
      }
    } catch {
      // Keep best-effort extracted content
    } finally {
      await browser?.close().catch(() => {});
    }
  }

  if (extracted.trim()) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, `${extracted.trim()}\n`, 'utf8');
  }
  return extracted.trim();
}

export function listAuditableTargets(projectId: string): PageAuditTargetOption[] {
  const seed = loadProjectSeed(projectId);
  const owned = seed.assets.filter((a) => resolveAssetOwnership(a, seed).ownership === 'owned');
  const options: PageAuditTargetOption[] = owned.map((asset) => {
    const localRepoPath = resolveLocalRepoFileForAsset(projectId, asset);
    const liveWeb = !localRepoPath && isLiveWebUrl(asset.publicUrl);
    return {
      assetId: asset.id,
      label: formatAssetLabel(asset, localRepoPath),
      targetKind: liveWeb ? 'live_web' : 'repo_doc',
      publicUrl: asset.publicUrl,
      localFilePath: localRepoPath ? path.relative(process.cwd(), localRepoPath).split(path.sep).join('/') : null,
    };
  });

  // Ensure pure public SaaS / website projects with `siteUrl` always have a first-class live_web homepage target
  const siteUrl = seed.project.siteUrl?.trim() || '';
  if (isLiveWebUrl(siteUrl)) {
    const siteStem = normalizeUrlStem(siteUrl);
    const alreadyListed = options.some((opt) => normalizeUrlStem(opt.publicUrl) === siteStem);
    if (!alreadyListed) {
      options.unshift({
        assetId: LIVE_SITE_HOME_ASSET_ID,
        label: formatPublicUrlLabel(siteUrl, seed.project.name),
        targetKind: 'live_web',
        publicUrl: siteUrl,
        localFilePath: null,
      });
    }
  }
  return options;
}

async function selectTargetOwnedAssetAsync(
  projectId: string,
  preferredAssetId?: string,
  signal?: AbortSignal,
): Promise<{
  asset: GeoAsset;
  markdown: string;
  localRepoPath: string | null;
  targetKind: 'repo_doc' | 'live_web';
  targetLabel: string;
}> {
  const seed = loadProjectSeed(projectId);
  const owned = seed.assets.filter((a) => resolveAssetOwnership(a, seed).ownership === 'owned');
  const siteUrl = seed.project.siteUrl?.trim() || '';

  const buildVirtualSiteTarget = async () => {
    if (!isLiveWebUrl(siteUrl)) {
      throw new Error('当前项目还没有登记可体检的自有页面、官网地址或 README 文档。');
    }
    const markdown = await fetchLiveWebPageMarkdown(projectId, siteUrl, { signal });
    if (!markdown.trim()) {
      throw new Error(`未能抓取公开官网「${siteUrl}」的页面正文，请检查网址是否可公开访问。`);
    }
    const virtualAsset: GeoAsset = {
      id: LIVE_SITE_HOME_ASSET_ID,
      title: formatPublicUrlLabel(siteUrl, seed.project.name),
      type: 'homepage',
      language: resolveProjectTargetLanguage(seed.project),
      status: 'published',
      publishedAt: '',
      publicUrl: siteUrl,
      summary: seed.project.description || '',
      sourcePath: '',
      evidencePaths: [],
      markdown,
    };
    return {
      asset: virtualAsset,
      markdown,
      localRepoPath: null,
      targetKind: 'live_web' as const,
      targetLabel: formatPublicUrlLabel(siteUrl, seed.project.name),
    };
  };

  if (preferredAssetId === LIVE_SITE_HOME_ASSET_ID) {
    return buildVirtualSiteTarget();
  }

  let chosen = preferredAssetId ? owned.find((a) => a.id === preferredAssetId) : undefined;
  if (!chosen) {
    // Prefer README.md for local/GitHub repos, or homepage / live website for SaaS projects
    chosen =
      owned.find((a) => /readme\.md$/i.test(a.publicUrl || '') || /\breadme\b/i.test(a.title)) ??
      owned.find((a) => a.type === 'homepage' || a.type === 'landing_page') ??
      owned[0];
  }

  if (!chosen) {
    return buildVirtualSiteTarget();
  }

  const resolved = resolveOwnedAssetContent(projectId, chosen.id);
  const localRepoPath = resolved.localRepoPath ?? null;
  const targetKind: 'repo_doc' | 'live_web' =
    !localRepoPath && isLiveWebUrl(chosen.publicUrl) ? 'live_web' : 'repo_doc';

  let markdown = resolved.markdown?.trim() ?? '';
  if (targetKind === 'live_web' && markdown.length < 180 && chosen.publicUrl) {
    const liveMd = await fetchLiveWebPageMarkdown(projectId, chosen.publicUrl, { signal });
    if (liveMd.length > markdown.length) {
      markdown = liveMd;
    }
  }

  if (!markdown) {
    throw new Error(`未能读取「${chosen.title}」的页面正文，无法开展分块体检。`);
  }

  return {
    asset: chosen,
    markdown,
    localRepoPath,
    targetKind,
    targetLabel: formatAssetLabel(chosen, localRepoPath),
  };
}

function loadFullMeasuredAnswers(projectId: string, targetLanguage: 'en' | 'zh'): AnswerShardItem[] {
  return withProjectDb(projectId, (db, id) => {
    ensureProjectRelationalData(id, db);
    const questions = db
      .prepare(
        `SELECT id, query_en, query_zh FROM opengeo_questions WHERE project_id = ? AND status = 'active' ORDER BY sort_order ASC`,
      )
      .all(id) as Array<{ id: string; query_en: string; query_zh: string }>;

    const items: AnswerShardItem[] = [];
    for (const q of questions) {
      for (const engine of ['chatgpt', 'google'] as const) {
        type Row = {
          query_text: string;
          answer_path: string | null;
          evidence_path: string;
          sources_json: string;
          mention: string | null;
          citation: string | null;
        };
        const langRow = db
          .prepare(
            `SELECT o.query_text, o.answer_path, o.evidence_path, o.sources_json, a.mention, a.citation
             FROM opengeo_observations o
             LEFT JOIN opengeo_answer_audits a
               ON a.project_id = o.project_id AND a.observation_id = o.id AND a.is_current = 1
             WHERE o.project_id = ? AND o.question_id = ? AND o.engine = ? AND o.language = ?
             ORDER BY o.seq DESC LIMIT 1`,
          )
          .get(id, q.id, engine, targetLanguage) as Row | undefined;

        const row =
          langRow ??
          (db
            .prepare(
              `SELECT o.query_text, o.answer_path, o.evidence_path, o.sources_json, a.mention, a.citation
               FROM opengeo_observations o
               LEFT JOIN opengeo_answer_audits a
                 ON a.project_id = o.project_id AND a.observation_id = o.id AND a.is_current = 1
               WHERE o.project_id = ? AND o.question_id = ? AND o.engine = ?
               ORDER BY o.seq DESC LIMIT 1`,
            )
            .get(id, q.id, engine) as Row | undefined);

        if (!row) continue;
        const relPath = row.answer_path ?? row.evidence_path;
        if (!relPath) continue;
        const fullPath = withGeoProject(id, () => evidenceLocation(relPath).target);
        if (!fs.existsSync(fullPath)) continue;
        const answerText = readAnswerTextFromFile(fullPath).trim();
        if (!answerText) continue;

        const sources = parseSourcesJson(row.sources_json).map((s) => ({
          title: s.title || s.url,
          url: s.url,
        }));

        items.push({
          questionId: q.id,
          engine,
          query: row.query_text || (targetLanguage === 'zh' ? q.query_zh || q.query_en : q.query_en || q.query_zh),
          mention: row.mention ?? 'unknown',
          citation: row.citation ?? 'unknown',
          answerText,
          sources,
        });
      }
    }
    return items;
  });
}

/**
 * Best-effort live DOM section screenshot capture for BOTH public websites (`siteUrl`)
 * AND rendered GitHub repo / README pages (`github.com/...`).
 * Highlights the exact matched DOM block with a crisp forest-green frame and crops cleanly.
 * Never throws or fails an audit if Playwright/network is unavailable.
 */
export async function captureLiveWebSectionScreenshots(
  projectId: string,
  auditId: string,
  targetUrl: string,
  findings: PageAuditFinding[],
  onProgress?: (step: HumanProgressStep) => void,
): Promise<void> {
  if (!isPublicRenderableUrl(targetUrl) || !findings.length) return;
  let browser: { close: () => Promise<void> } | null = null;
  try {
    onProgress?.({
      at: new Date().toISOString(),
      agentId: 'page-section-auditor',
      kind: 'tool',
      message: `正在打开线上页面定位对应区块并截取局部高亮图…`,
    });
    const pw = await import('playwright');
    let launched: Awaited<ReturnType<typeof pw.chromium.launch>> | null = null;
    for (const launchOpts of [
      { headless: true },
      { headless: true, channel: 'chrome' as const },
      { headless: true, channel: 'msedge' as const },
    ]) {
      try {
        launched = await pw.chromium.launch(launchOpts);
        break;
      } catch {
        // Try next available system Chromium channel
      }
    }
    if (!launched) return;
    browser = launched;
    const context = await launched.newContext({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();

    const isGitHub = /(?:^|\.)github\.com$/i.test(new URL(targetUrl).hostname);
    // For GitHub root README.md blob URLs, the repo homepage renders the README cleanly in context
    const renderUrl = isGitHub
      ? targetUrl.replace(/\/blob\/[^/]+\/README\.md$/i, '')
      : targetUrl;

    await page.goto(renderUrl, { waitUntil: 'domcontentloaded', timeout: 18_000 });
    if (isGitHub) {
      await page.waitForSelector('article.markdown-body', { timeout: 10_000 }).catch(() => {});
    }
    await page.waitForTimeout(800);

    const outDir = auditShotsDirectory(projectId);
    fs.mkdirSync(outDir, { recursive: true });

    for (const finding of findings) {
      // Strip markdown formatting and HTML tags so anchorQuote matches rendered innerText cleanly
      const cleanQuote = finding.anchorQuote
        .replace(/<[^>]+>/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[`*_#>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 96);
      const cleanHeading = finding.sectionHeading
        .replace(/^Opening\s*\/\s*|^顶部介绍\s*·\s*/i, '')
        .trim();

      const box = await page.evaluate(
        ({ quote, headingText, ghMode }) => {
          document.querySelectorAll('[data-opengeo-audit-ring]').forEach((el) => {
            const htmlEl = el as HTMLElement;
            htmlEl.style.outline = '';
            htmlEl.style.outlineOffset = '';
            htmlEl.style.boxShadow = '';
            htmlEl.style.backgroundColor = '';
            htmlEl.style.borderRadius = '';
            htmlEl.removeAttribute('data-opengeo-audit-ring');
          });

          const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
          const qNorm = norm(quote);
          const hNorm = norm(headingText);
          const root: ParentNode =
            ghMode && document.querySelector('article.markdown-body')
              ? document.querySelector('article.markdown-body')!
              : document;

          const selector = ghMode
            ? 'p, table, li, pre, blockquote, div[align], h1, h2, h3'
            : 'section, header, main > div, article, table, ul, ol, h1, h2, h3, p';
          const candidates = Array.from(root.querySelectorAll(selector));

          const findTightest = (needle: string): HTMLElement | null => {
            if (needle.length < 4) return null;
            let best: HTMLElement | null = null;
            let bestArea = Infinity;
            for (const el of candidates) {
              const htmlEl = el as HTMLElement;
              const rect = htmlEl.getBoundingClientRect();
              if (rect.width < 100 || rect.height < 18 || rect.height > 1200) continue;
              const txt = norm(htmlEl.innerText || '');
              if (!txt || !txt.includes(needle)) continue;
              const area = rect.width * rect.height;
              if (area < bestArea) {
                bestArea = area;
                best = htmlEl;
              }
            }
            return best;
          };

          // Prefer matching the exact anchor quote first (try 40-char, then 24-char prefix), fallback to heading
          let best =
            (qNorm.length >= 24 ? findTightest(qNorm.slice(0, 40)) : null) ??
            (qNorm.length >= 12 ? findTightest(qNorm.slice(0, Math.min(24, qNorm.length))) : null) ??
            findTightest(hNorm);

          if (!best) return null;

          // On non-GitHub sites, step up to immediate card/section wrapper when matching a short heading
          const target =
            !ghMode &&
            best.tagName.match(/^H[1-3]$/) &&
            best.parentElement &&
            best.parentElement.getBoundingClientRect().height < 520
              ? best.parentElement
              : best;

          target.scrollIntoView({ behavior: 'instant', block: 'center' });
          target.setAttribute('data-opengeo-audit-ring', '1');
          // Calm amber dashed highlight for existing page gap (distinct from forest-green suggested edit!)
          target.style.outline = '2px dashed #d97706';
          target.style.outlineOffset = '5px';
          target.style.borderRadius = '8px';
          target.style.backgroundColor = 'rgba(254, 243, 199, 0.36)';
          target.style.boxShadow = '0 0 0 6px rgba(217, 119, 6, 0.11)';

          const r = target.getBoundingClientRect();
          const rootRect =
            ghMode && root instanceof HTMLElement ? root.getBoundingClientRect() : null;
          // Generous wide surrounding context so users immediately recognize where on the real page this lives
          const padTop = best.tagName.match(/^H[1-3]$/) ? 110 : 145;
          const padBottom = best.tagName.match(/^H[1-3]$/) ? 220 : 145;
          const left = rootRect
            ? Math.max(0, Math.floor(rootRect.left - 36))
            : 20;
          const right = rootRect
            ? Math.min(1280, Math.ceil(rootRect.right + 36))
            : 1260;
          // Near the top of page, include the top chrome / hero header naturally
          const top = r.top < 240 && window.scrollY < 180 ? 0 : Math.max(0, Math.floor(r.top - padTop));
          const idealHeight = Math.ceil(r.height + padTop + padBottom);
          const height = Math.min(540, Math.max(300, idealHeight));
          return {
            x: left,
            y: top,
            width: Math.max(480, right - left),
            height: Math.min(height, 900 - top),
          };
        },
        { quote: cleanQuote, headingText: cleanHeading, ghMode: isGitHub },
      );

      if (box && box.width >= 200 && box.height >= 120) {
        const filename = `${auditId}-${finding.id}.png`;
        await page.screenshot({
          path: path.join(outDir, filename),
          clip: {
            x: box.x,
            y: box.y,
            width: Math.min(box.width, 1280 - box.x),
            height: Math.min(box.height, 900 - box.y),
          },
        });
        finding.screenshotFile = filename;
      }
    }
  } catch {
    // Best-effort visual enhancement: silently fall back to highlighted text anchor preview
  } finally {
    await browser?.close().catch(() => {});
  }
}

/** Captures/refreshes highlighted live-page section screenshots for the latest saved audit (0 LLM cost). */
export async function refreshPageAuditScreenshots(projectId: string): Promise<PageAuditRecord | null> {
  const existing = readLatestPageAudit(projectId);
  if (!existing || !existing.targetUrl || !isPublicRenderableUrl(existing.targetUrl)) {
    return existing;
  }
  const findingsCopy = existing.findings.map((f) => ({ ...f }));
  await captureLiveWebSectionScreenshots(projectId, existing.id, existing.targetUrl, findingsCopy);
  const updated: PageAuditRecord = {
    ...existing,
    findings: findingsCopy,
    updatedAt: new Date().toISOString(),
  };
  return saveLatestPageAudit(projectId, updated);
}

export interface RunPageAuditOptions {
  assetId?: string;
  uiLanguage?: 'en' | 'zh';
  preferredProvider?: 'gemini' | 'deepseek';
  transport?: LLMTransport;
  concurrency?: number;
  captureLiveScreenshots?: boolean;
  onProgress?: (step: HumanProgressStep) => void;
  signal?: AbortSignal;
}

/**
 * End-to-end unified Map-Reduce Page Content Audit built directly on AgentHub:
 *   Pass 1 (Map-Reduce): Parallel shards read full ChatGPT & Google AI answers -> AnswerSignalSheet
 *   Pass 2 (Section Audit): Section-chunked target doc/page + local codebase verification -> 3-5 Findings
 *   Optional: Live web DOM highlight screenshots for website targets
 */
export async function runPageContentAudit(
  projectId: string,
  options: RunPageAuditOptions = {},
): Promise<PageAuditRecord> {
  const seed = loadProjectSeed(projectId);
  const targetLanguage = resolveProjectTargetLanguage(seed.project);
  const uiLanguage = options.uiLanguage ?? resolveProjectUiLanguage(seed.project);
  const isEn = uiLanguage === 'en';
  const progress: HumanProgressStep[] = [];
  const emit = (step: HumanProgressStep) => {
    progress.push(step);
    options.onProgress?.(step);
  };

  const target = await selectTargetOwnedAssetAsync(projectId, options.assetId, options.signal);
  const sections = parsePageSections(target.markdown, isEn);
  if (!sections.length) {
    throw new Error(`「${target.targetLabel}」正文为空，请先补充基础文档后再体检。`);
  }

  const allAnswers = loadFullMeasuredAnswers(projectId, targetLanguage);
  if (!allAnswers.length) {
    throw new Error('当前项目还没有可用的 ChatGPT 或 Google AI 实测回答原文，请先运行一次浏览器实测。');
  }

  const shards = buildEngineAnswerShards(allAnswers, {
    maxPerShard: 4,
    uiLanguage,
    projectName: seed.project.name,
  });

  emit({
    at: new Date().toISOString(),
    agentId: 'page-audit',
    kind: 'start',
    message: isEn
      ? `Splitting ${allAnswers.length} full AI answers into ${shards.length} parallel shards (ChatGPT / Google)…`
      : `正在把 ${allAnswers.length} 条完整 AI 回答拆成 ${shards.length} 个分片（按 ChatGPT / Google 并发阅读）…`,
  });

  // Pass 1: Unified AgentHub Map-Reduce over full AI answers
  const mrResult = await defaultAgentHub.mapReduce({
    mapSpec: answerSignalMapperAgent,
    mapInputs: shards,
    reduceSpec: answerSignalReducerAgent,
    buildReduceInput: (mapped) => ({
      projectName: seed.project.name,
      uiLanguage,
      shards: mapped,
    }),
    concurrency: options.concurrency ?? 4,
    shardLabel: (shard) =>
      `${shard.engine === 'chatgpt' ? 'ChatGPT' : 'Google'} ${shard.shardIndex}/${shard.shardTotal}`,
    projectId,
    transport: options.transport,
    preferredProvider: options.preferredProvider,
    signal: options.signal,
    onProgress: emit,
  });

  // Pass 2: Section-level Page Auditor with local codebase tools
  const auditRes = await defaultAgentHub.run(
    pageSectionAuditorAgent,
    {
      targetLabel: target.targetLabel,
      targetKind: target.targetKind,
      targetLanguage,
      uiLanguage,
      signalSheet: mrResult.output,
      sections,
    },
    {
      projectId,
      transport: options.transport,
      preferredProvider: options.preferredProvider,
      signal: options.signal,
      onProgress: emit,
    },
  );

  const sectionMap = new Map(sections.map((s) => [s.id, s]));
  const auditId = `pa-${randomUUID().slice(0, 8)}`;

  const findings: PageAuditFinding[] = auditRes.output.findings.map((raw, idx) => {
    const section = sectionMap.get(raw.sectionId) ?? sections[0];
    const { excerpt, anchor } = buildSectionExcerpt(section, raw.anchorQuote);
    return {
      id: `f-${idx + 1}`,
      category: raw.category,
      impact: raw.impact,
      sectionId: section.id,
      sectionHeading: section.heading,
      startLine: section.startLine,
      endLine: section.endLine,
      sectionExcerpt: excerpt,
      anchorQuote: anchor,
      title: raw.title,
      whyAiMissed: raw.whyAiMissed,
      citedEngines: raw.citedEngines,
      codebaseFact: raw.codebaseFact,
      suggestedDirection: raw.suggestedDirection,
      status: 'open',
    };
  });

  if (
    options.captureLiveScreenshots !== false &&
    target.asset.publicUrl &&
    isPublicRenderableUrl(target.asset.publicUrl)
  ) {
    await captureLiveWebSectionScreenshots(
      projectId,
      auditId,
      target.asset.publicUrl,
      findings,
      emit,
    );
  }

  const nowIso = new Date().toISOString();
  const previousShipped = readLatestPageAudit(projectId)?.shippedRecords ?? [];
  const record: PageAuditRecord = {
    id: auditId,
    projectId,
    targetAssetId: target.asset.id,
    targetLabel: target.targetLabel,
    targetUrl: target.asset.publicUrl ?? null,
    localFilePath: target.localRepoPath
      ? path.relative(process.cwd(), target.localRepoPath).split(path.sep).join('/')
      : null,
    targetKind: target.targetKind,
    targetLanguage,
    uiLanguage,
    shardStats: {
      totalAnswers: allAnswers.length,
      chatgptAnswers: allAnswers.filter((a) => a.engine === 'chatgpt').length,
      googleAnswers: allAnswers.filter((a) => a.engine === 'google').length,
      shardCount: shards.length,
    },
    signalSheet: mrResult.output,
    findings,
    progress,
    ...(previousShipped.length > 0 ? { shippedRecords: previousShipped } : {}),
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  return saveLatestPageAudit(projectId, record);
}

async function resolveAuditTargetMarkdownAsync(
  projectId: string,
  audit: PageAuditRecord,
  signal?: AbortSignal,
): Promise<{ markdown: string; localRepoPath: string | null; sourcePath: string | null }> {
  if (audit.targetAssetId === LIVE_SITE_HOME_ASSET_ID && audit.targetUrl) {
    const md = await fetchLiveWebPageMarkdown(projectId, audit.targetUrl, { signal });
    if (!md) throw new Error('无法读取公开网站页面快照，请重新体检后再试。');
    return { markdown: md, localRepoPath: null, sourcePath: null };
  }
  const resolved = resolveOwnedAssetContent(projectId, audit.targetAssetId);
  if (resolved.found && resolved.markdown?.trim()) {
    return {
      markdown: resolved.markdown,
      localRepoPath: resolved.localRepoPath ?? null,
      sourcePath: resolved.asset?.sourcePath ?? null,
    };
  }
  if (audit.targetKind === 'live_web' && audit.targetUrl) {
    const md = await fetchLiveWebPageMarkdown(projectId, audit.targetUrl, { signal });
    if (md) return { markdown: md, localRepoPath: null, sourcePath: null };
  }
  throw new Error('无法读取目标页面当前内容，请刷新后重试。');
}

/**
 * Pass 3 (On-demand): Generates a surgical preview for ONE finding only (no whole-file rewrite).
 */
export async function previewPageFindingPatch(
  projectId: string,
  findingId: string,
  options: {
    preferredProvider?: 'gemini' | 'deepseek';
    transport?: LLMTransport;
    signal?: AbortSignal;
  } = {},
): Promise<PageAuditRecord> {
  const existing = readLatestPageAudit(projectId);
  if (!existing) {
    throw new Error('请先运行页面分块体检，再生成单处修改预览。');
  }
  const finding = existing.findings.find((f) => f.id === findingId);
  if (!finding) {
    throw new Error('未找到对应的体检诊断条目。');
  }

  const targetContent = await resolveAuditTargetMarkdownAsync(projectId, existing, options.signal);
  const sections = parsePageSections(targetContent.markdown, existing.uiLanguage === 'en');
  const section =
    sections.find((s) => s.id === finding.sectionId) ??
    sections.find((s) => s.heading === finding.sectionHeading) ??
    sections[0];
  if (!section) {
    throw new Error('未定位到对应页面区块。');
  }

  const patchRes = await defaultAgentHub.run(
    sectionSurgicalPatcherAgent,
    {
      targetLabel: existing.targetLabel,
      targetLanguage: existing.targetLanguage,
      uiLanguage: existing.uiLanguage,
      finding,
      section,
    },
    {
      projectId,
      transport: options.transport,
      preferredProvider: options.preferredProvider,
      signal: options.signal,
    },
  );

  const previewAfterBlock =
    patchRes.output.insertionMode === 'insert_after'
      ? `${patchRes.output.beforeExcerpt.trim()}\n\n${patchRes.output.afterExcerpt.trim()}`
      : patchRes.output.afterExcerpt.trim();

  const unifiedDiff = computeCompactUnifiedDiff(
    patchRes.output.beforeExcerpt.trim(),
    previewAfterBlock,
    section.startLine,
  );

  const nowIso = new Date().toISOString();
  const updated: PageAuditRecord = {
    ...existing,
    updatedAt: nowIso,
    findings: existing.findings.map((f) =>
      f.id === findingId
        ? {
            ...f,
            status: 'open',
            patchPreview: {
              ...patchRes.output,
              unifiedDiff,
              generatedAt: nowIso,
              model: patchRes.model,
            },
          }
        : f,
    ),
  };

  return saveLatestPageAudit(projectId, updated);
}

/**
 * Pass 3 (Parallel Batch): Generates surgical previews for multiple findings concurrently via AgentHub.runBatch.
 */
export async function previewPageFindingBatch(
  projectId: string,
  findingIds?: string[],
  options: {
    forceRegenerate?: boolean;
    preferredProvider?: 'gemini' | 'deepseek';
    transport?: LLMTransport;
    concurrency?: number;
    signal?: AbortSignal;
  } = {},
): Promise<PageAuditRecord> {
  const existing = readLatestPageAudit(projectId);
  if (!existing) {
    throw new Error('请先运行页面分块体检，再批量生成修改预览。');
  }

  const wantedIds = findingIds?.length
    ? new Set(findingIds)
    : new Set(existing.findings.filter((f) => f.status === 'open').map((f) => f.id));

  const targets = existing.findings.filter(
    (f) => wantedIds.has(f.id) && (options.forceRegenerate || !f.patchPreview),
  );
  if (!targets.length) {
    return existing;
  }

  const targetContent = await resolveAuditTargetMarkdownAsync(projectId, existing, options.signal);
  const sections = parsePageSections(targetContent.markdown, existing.uiLanguage === 'en');
  if (!sections.length) {
    throw new Error('未定位到目标页面的可改写区块。');
  }

  const inputs: SectionPatcherInput[] = targets.map((finding) => {
    const section =
      sections.find((s) => s.id === finding.sectionId) ??
      sections.find((s) => s.heading === finding.sectionHeading) ??
      sections[0];
    return {
      targetLabel: existing.targetLabel,
      targetLanguage: existing.targetLanguage,
      uiLanguage: existing.uiLanguage,
      finding,
      section,
    };
  });

  const batchResults = await defaultAgentHub.runBatch(sectionSurgicalPatcherAgent, inputs, {
    projectId,
    concurrency: options.concurrency ?? 3,
    transport: options.transport,
    preferredProvider: options.preferredProvider,
    signal: options.signal,
  });

  const nowIso = new Date().toISOString();
  const previewById = new Map<string, PageAuditFinding['patchPreview']>();
  for (let i = 0; i < targets.length; i += 1) {
    const finding = targets[i];
    const section = inputs[i].section;
    const res = batchResults.results[i];
    const previewAfterBlock =
      res.output.insertionMode === 'insert_after'
        ? `${res.output.beforeExcerpt.trim()}\n\n${res.output.afterExcerpt.trim()}`
        : res.output.afterExcerpt.trim();
    const unifiedDiff = computeCompactUnifiedDiff(
      res.output.beforeExcerpt.trim(),
      previewAfterBlock,
      section.startLine,
    );
    previewById.set(finding.id, {
      ...res.output,
      unifiedDiff,
      generatedAt: nowIso,
      model: res.model,
    });
  }

  const updated: PageAuditRecord = {
    ...existing,
    updatedAt: nowIso,
    findings: existing.findings.map((f) =>
      previewById.has(f.id)
        ? { ...f, patchPreview: previewById.get(f.id) }
        : f,
    ),
  };

  return saveLatestPageAudit(projectId, updated);
}

/**
 * Safely applies ONE previewed surgical patch directly to a real writable local repository file.
 * Never modifies stored evidence snapshots under data/.
 */
export function applyPageFindingPatch(
  projectId: string,
  findingId: string,
): { audit: PageAuditRecord; writtenPath: string | null } {
  const res = applyPageFindingBatch(projectId, [findingId]);
  if (!res.appliedIds.includes(findingId)) {
    throw new OptimizationStateError(res.errors[0] || '应用该处改动失败，请先生成修改预览。', 400);
  }
  return { audit: res.audit, writtenPath: res.writtenPath };
}

/**
 * Safely applies a batch of previewed surgical patches sequentially ONLY when a real writable
 * local repository file exists on disk. Never mutates stored evidence snapshots under data/.
 * For pure live websites or remote repositories without a local checkout, users copy the brief
 * and call markPageAuditFindingsLive() once live with a verified URL.
 */
export function applyPageFindingBatch(
  projectId: string,
  findingIds: string[],
): { audit: PageAuditRecord; appliedIds: string[]; errors: string[]; writtenPath: string | null } {
  const existing = readLatestPageAudit(projectId);
  if (!existing) {
    throw new OptimizationStateError('未找到页面体检记录。', 404);
  }
  const wanted = findingIds.filter(Boolean);
  if (!wanted.length) {
    throw new OptimizationStateError('请至少勾选 1 处改动后再应用。', 400);
  }

  const resolved =
    existing.targetAssetId === LIVE_SITE_HOME_ASSET_ID
      ? { found: false, localRepoPath: null, asset: undefined, markdown: undefined }
      : resolveOwnedAssetContent(projectId, existing.targetAssetId);

  const writableLocal =
    resolved.localRepoPath && fs.existsSync(resolved.localRepoPath) ? resolved.localRepoPath : null;

  if (!writableLocal) {
    throw new OptimizationStateError(
      '当前目标页面没有可写的本地仓库文件，不会改写 data/ 中的原始观测快照；请复制改稿清单并更新线上页面后，点击「我已上线」并填入线上链接入账。',
      400,
    );
  }

  let currentContent = resolved.markdown ?? fs.readFileSync(writableLocal, 'utf8');
  let mutated = false;
  const appliedIds: string[] = [];
  const errors: string[] = [];

  for (const id of wanted) {
    const finding = existing.findings.find((f) => f.id === id);
    if (!finding) {
      errors.push(`未找到诊断条目 ${id}`);
      continue;
    }
    if (!finding.patchPreview) {
      errors.push(`「${finding.title}」尚未生成改稿预览`);
      continue;
    }
    try {
      const { patchedContent } = applySurgicalPatchToContent(currentContent, finding.patchPreview);
      currentContent = patchedContent;
      mutated = true;
      appliedIds.push(id);
    } catch (err) {
      errors.push(`「${finding.title}」：${err instanceof Error ? err.message : '锚点定位失败'}`);
    }
  }

  let writtenPath: string | null = null;
  if (mutated && appliedIds.length > 0) {
    fs.writeFileSync(writableLocal, `${currentContent.trimEnd()}\n`, 'utf8');
    writtenPath = path.relative(process.cwd(), writableLocal).split(path.sep).join('/');
  }

  const appliedSet = new Set(appliedIds);
  const nowIso = new Date().toISOString();
  const updated: PageAuditRecord = {
    ...existing,
    updatedAt: nowIso,
    findings: existing.findings.map((f) =>
      appliedSet.has(f.id) ? { ...f, status: 'applied', appliedAt: nowIso } : f,
    ),
  };

  return {
    audit: appliedIds.length > 0 ? saveLatestPageAudit(projectId, updated) : existing,
    appliedIds,
    errors,
    writtenPath,
  };
}

/**
 * Records Track 1 page updates as explicitly shipped live with a verified public URL and timestamp,
 * closing the loop into Shipped Log and the retest clock without ever mutating stored snapshots.
 */
export function markPageAuditFindingsLive(
  projectId: string,
  findingIds: string[],
  options: { liveUrl: string; note?: string },
): { audit: PageAuditRecord; shippedRecord: PageAuditShippedRecord } {
  const existing = readLatestPageAudit(projectId);
  if (!existing) {
    throw new OptimizationStateError('未找到页面体检记录。', 404);
  }
  const cleanUrl = options.liveUrl.trim();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(cleanUrl);
  } catch {
    throw new OptimizationStateError('请填入有效的线上公开链接（以 http:// 或 https:// 开头）。', 400);
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new OptimizationStateError('线上公开链接必须以 http:// 或 https:// 开头。', 400);
  }

  const wanted = findingIds.filter(Boolean);
  const matchedFindings =
    wanted.length > 0
      ? existing.findings.filter((f) => wanted.includes(f.id))
      : existing.findings.filter((f) => f.status !== 'dismissed');
  if (matchedFindings.length === 0) {
    throw new OptimizationStateError('请至少选择 1 处已上线的修改条目。', 400);
  }

  const matchedIds = new Set(matchedFindings.map((f) => f.id));
  const nowIso = new Date().toISOString();
  const shippedRecord: PageAuditShippedRecord = {
    id: `pa-ship-${randomUUID().slice(0, 8)}`,
    targetLabel: existing.targetLabel,
    liveUrl: parsedUrl.href,
    findingIds: matchedFindings.map((f) => f.id),
    findingTitles: matchedFindings.map((f) => f.title),
    shippedAt: nowIso,
    ...(options.note?.trim() ? { note: options.note.trim() } : {}),
  };

  const updated: PageAuditRecord = {
    ...existing,
    updatedAt: nowIso,
    findings: existing.findings.map((f) =>
      matchedIds.has(f.id)
        ? { ...f, status: 'applied', appliedAt: f.appliedAt || nowIso }
        : f,
    ),
    shippedRecords: [shippedRecord, ...(existing.shippedRecords ?? [])],
  };

  return {
    audit: saveLatestPageAudit(projectId, updated),
    shippedRecord,
  };
}

/**
 * One click from approved edits to live for a document in the project's GitHub repository:
 * re-applies the chosen verbatim patches onto a fresh clone of the file on GitHub, pushes them to
 * the default branch and logs them live with the GitHub link. Newer remote changes are kept, edits
 * already on GitHub are not added twice, and the user's own working copy is never touched.
 */
export function publishPageFindingsToGitHub(
  projectId: string,
  findingIds: string[],
  options: Pick<PublishGitHubOptions, 'remoteUrlOverride' | 'branchOverride'> = {},
): { audit: PageAuditRecord; shippedRecord: PageAuditShippedRecord; commitHash: string; branch: string; changed: boolean } {
  const existing = readLatestPageAudit(projectId);
  if (!existing) {
    throw new OptimizationStateError('No page audit found.', 404, 'page_audit_missing');
  }
  const slug = parseGitHubRepoSlug(loadProjectSeed(projectId).project.repositoryUrl);
  const repoPath = existing.targetUrl ? resolveRepoRelativeDocPath(existing.targetUrl, slug) : null;
  if (!repoPath) {
    throw new OptimizationStateError(`${existing.targetUrl || existing.targetLabel} is not a document in the project's GitHub repository.`, 400, 'github_publish_not_repo_doc');
  }
  const wanted = new Set(findingIds.filter(Boolean));
  const findings = existing.findings.filter((f) => wanted.has(f.id) && f.status !== 'dismissed' && f.patchPreview);
  if (!findings.length) {
    throw new OptimizationStateError('No drafted edit was selected.', 400, 'github_publish_nothing_selected');
  }

  const remoteChanged = (title: string) => new OptimizationStateError(
    `${repoPath} on GitHub no longer contains the text "${title}" edits.`, 409, 'github_publish_remote_changed');
  const pushed = pushEditsToProjectRepo(projectId, `docs: improve ${repoPath} via OpenGEO`, (cloneDir) => {
    const filePath = path.join(cloneDir, repoPath);
    if (!fs.existsSync(filePath)) throw remoteChanged(findings[0].title);
    let content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
    let edited = false;
    for (const finding of findings) {
      const patch = finding.patchPreview!;
      // Already on GitHub (published earlier or by hand): adding it again would duplicate it.
      if (content.includes(patch.afterExcerpt.replace(/\r\n/g, '\n').trim())) continue;
      try {
        content = applySurgicalPatchToContent(content, patch).patchedContent;
        edited = true;
      } catch {
        throw remoteChanged(finding.title);
      }
    }
    if (edited) fs.writeFileSync(filePath, `${content.trimEnd()}\n`, 'utf8');
    return [repoPath];
  }, options);

  const liveUrl = pushed.slug
    ? `https://github.com/${pushed.slug.owner}/${pushed.slug.repo}/blob/${pushed.defaultBranch}/${repoPath}`
    : existing.targetUrl!;
  const en = existing.uiLanguage === 'en';
  const note = pushed.changed
    ? (en ? `Pushed to ${pushed.defaultBranch} (${pushed.commitHash})` : `已推送到 ${pushed.defaultBranch}（${pushed.commitHash}）`)
    : (en ? `${pushed.defaultBranch} already had these edits (${pushed.commitHash})` : `${pushed.defaultBranch} 已包含这些修改（${pushed.commitHash}）`);
  const { audit, shippedRecord } = markPageAuditFindingsLive(projectId, findings.map((f) => f.id), { liveUrl, note });
  return { audit, shippedRecord, commitHash: pushed.commitHash, branch: pushed.defaultBranch, changed: pushed.changed };
}

/**
 * Pure helper for pure SaaS / live websites without a local repository:
 * builds a crisp, copy-paste-ready Markdown change brief for CMS / Webflow / frontend teams.
 */
export function buildLiveWebChangeBrief(
  audit: PageAuditRecord,
  findingIds?: string[],
): string {
  const wanted = findingIds?.length ? new Set(findingIds) : null;
  const selected = audit.findings.filter((f) => (wanted ? wanted.has(f.id) : f.status !== 'dismissed'));
  const header = [
    `# ${audit.targetLabel} — Page Update Brief`,
    ...(audit.targetUrl ? [`URL: ${audit.targetUrl}`] : []),
    `Generated from ${audit.shardStats.totalAnswers} live AI answers (${audit.shardStats.chatgptAnswers} ChatGPT / ${audit.shardStats.googleAnswers} Google AI).`,
    '',
  ];
  const sections = selected.map((f, idx) => {
    const modeLabel =
      f.patchPreview?.insertionMode === 'insert_after'
        ? 'Insert right after the matched block'
        : 'Replace the matched block';
    return [
      `## ${idx + 1}. ${f.title} (${f.sectionHeading})`,
      `- **Why**: ${f.whyAiMissed}`,
      `- **Verified basis**: ${f.codebaseFact}`,
      `- **Target spot**: "${f.anchorQuote}"`,
      ...(f.patchPreview
        ? [
            `- **How**: ${modeLabel}`,
            '',
            '```markdown',
            f.patchPreview.afterExcerpt.trim(),
            '```',
          ]
        : [`- **Suggested direction**: ${f.suggestedDirection}`]),
      '',
    ].join('\n');
  });
  return [...header, ...sections].join('\n').trim();
}

export function updatePageFindingStatus(
  projectId: string,
  findingId: string,
  status: 'open' | 'dismissed',
): PageAuditRecord {
  const existing = readLatestPageAudit(projectId);
  if (!existing) {
    throw new Error('未找到页面体检记录。');
  }
  const nowIso = new Date().toISOString();
  const updated: PageAuditRecord = {
    ...existing,
    updatedAt: nowIso,
    findings: existing.findings.map((f) => (f.id === findingId ? { ...f, status } : f)),
  };
  return saveLatestPageAudit(projectId, updated);
}

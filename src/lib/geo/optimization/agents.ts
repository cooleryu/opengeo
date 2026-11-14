import { z } from 'zod';
import { defaultAgentHub, type AgentSpec } from '../../agent-hub';
import { readAgentParameters, readAgentText } from '../agent-files';
import { resolveAssetOwnership } from '../asset-ownership';
import { ensureProjectRelationalData, withProjectDb } from '../db';
import { loadProjectSeed } from '../project-data';
import { getProjectOnboarding } from '../project-onboarding-store';
import {
  createProjectInspectionTools,
  formatMediaPathForDestination,
  listAvailableProjectMedia,
  localMediaPathExists,
} from '../agents/project-tools';
import type { ReferenceWinner } from './types';

const optimizationSkillParamsSchema = z.object({
  subscriptionTimeoutMs: z.number().int().positive().optional(),
  strategist: z.object({
    temperature: z.number().min(0).max(2),
    maxTurns: z.number().int().positive(),
  }),
  writer: z.object({
    temperature: z.number().min(0).max(2),
    maxTurns: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
  }),
  reviewer: z.object({
    temperature: z.number().min(0).max(2),
    maxTurns: z.number().int().positive(),
  }),
});

export function loadOptimizationSkillParams() {
  return readAgentParameters('improvement-planning', optimizationSkillParamsSchema);
}

const skillParams = loadOptimizationSkillParams();

export type OptimizationScenario = 'open-source-repo';

export function resolveProjectScenario(projectId: string): OptimizationScenario {
  try {
    const onboarding = getProjectOnboarding(projectId);
    if (onboarding?.kind === 'repository') return 'open-source-repo';
  } catch {
    // Non-onboarding or isolated test project defaults cleanly to open-source-repo until other packs ship
  }
  return 'open-source-repo';
}

export function resolveWriterArchetypeFile(
  scenario: OptimizationScenario,
  deliverable: { kind: string; destination: string; title: string },
): string {
  if (deliverable.kind === 'update_asset' && /readme/i.test(deliverable.destination)) {
    return `${scenario}/readme.md`;
  }
  if (
    !/\/blog\//i.test(deliverable.destination) &&
    /(?:getting-started|quickstart|start|how-it-works|docs\/guide)/i.test(deliverable.destination)
  ) {
    return `${scenario}/quickstart.md`;
  }
  return `${scenario}/public-article.md`;
}

export interface StrategistInput {
  mode: 'focus' | 'deep';
  targetLanguage?: 'en' | 'zh';
  uiLanguage?: 'en' | 'zh';
}

const plannedDeliverableSchema = z.object({
  priority: z.number().int().min(1).max(3),
  kind: z.enum(['update_asset', 'new_content']),
  format: z.enum(['rich_markdown', 'web_html']),
  title: z.string().min(4).max(200),
  targetAssetId: z.string().nullable(),
  destination: z.string().min(2).max(240),
  audienceAndGoal: z.string().min(10).max(800),
  questionIds: z.array(z.string().min(1)).min(1).max(8),
  writingBrief: z.string().min(20).max(3600),
});

export const strategistOutputSchema = z.object({
  summary: z.string().min(15).max(800),
  deliverables: z.array(plannedDeliverableSchema).min(1).max(3),
});

export type StrategistOutput = z.infer<typeof strategistOutputSchema>;

const INTERNAL_TOKEN_RE =
  /\b(?:project-[a-f0-9]{12,}|manual-[a-f0-9-]{8,}|model-\d+|opengeo_(?:projects|assets|questions|observations|answer_audits|optimization_runs|deliverables)|batchId|baseline_obs_ids)\b/i;

const LEGACY_DEFENSIVE_TAIL_RE =
  /(?:能说明什么.{0,8}不能说明什么|不等于改法已经?证明有效|样本差距不等于市场份额|审核通过.{0,4}不代表流量|当前为开发版|演示数据不随安装提供|仍然?由团队决定|仍由用户自己决定|未测、未知与真实零值|不是一个黑箱分数)/u;

const SELF_DIARY_TITLE_RE =
  /(?:给自己做\s*GEO|AI\s*为什么找不到(?:这个|我们)|介绍的却是另一个项目|我们(?:怎么|如何)(?:查自己|修好)|how\s+we\s+(?:audited|tested|fixed)\s+opengeo|why\s+(?:chatgpt|google|ai)\s+(?:confuses|ignores)\s+opengeo)/iu;

const AI_JARGON_AND_CLICHE_RE =
  /(?:身份锚点|实体消歧|显式否定|证据落点|证据密度|生成式引擎|同协议复测|自有内容引用率|问题不在.{1,18}而在于|两条结论，?先说清楚|值得注意的是|名字被叫到了，身份被别人拿走了)/u;

const TECH_SETUP_SCARE_RE =
  /\b(?:git\s+clone|npm\s+(?:install|run\s+dev|ci)|Node\.js\s*\d+|cp\s+\.env(?:\.example)?|localhost:\d{4}|127\.0\.0\.1:\d{4})\b/i;

function isDedicatedTechSetupDoc(destination: string): boolean {
  return /(?:getting-started|install|deploy|setup)/i.test(destination);
}

export const optimizationStrategistAgent: AgentSpec<StrategistInput, StrategistOutput> = {
  id: 'optimization-strategist',
  title: 'GEO 优化主编策略官',
  role: 'default',
  maxTurns: skillParams.strategist.maxTurns,
  temperature: skillParams.strategist.temperature,
  outputSchema: strategistOutputSchema,
  tools: (input) => createProjectInspectionTools({ targetLanguage: input.targetLanguage }),
  buildPrompt(input, ctx) {
    const seed = loadProjectSeed(ctx.projectId);
    const maxItems = input.mode === 'focus' ? 1 : 3;
    const scenario = resolveProjectScenario(ctx.projectId);
    const strategistSystem = readAgentText('improvement-planning', `${scenario}/strategist.md`);
    const uiLang = input.uiLanguage ?? seed.project.uiLanguage ?? 'zh';
    const targetLang = input.targetLanguage ?? seed.project.targetLanguage ?? 'en';
    const langInstruction = [
      `控制台展示语言（uiLanguage）= "${uiLang}"：summary 与 audienceAndGoal 必须使用 ${uiLang === 'en' ? 'English' : '简体中文'} 撰写。`,
      `对外推广成稿语言（targetLanguage）= "${targetLang}"：若为 "en"，deliverables 的 title、writingBrief 与建议 destination 必须面向英文开发者市场撰写。`,
    ].join('\n');
    return {
      system: [
        strategistSystem,
        `当前运行模式：${input.mode}，最多规划 ${maxItems} 份互补交付物（服从实际短板，不凑数）。`,
        langInstruction,
      ].join('\n\n'),
      user: JSON.stringify({
        mode: input.mode,
        uiLanguage: uiLang,
        targetLanguage: targetLang,
        project: {
          name: seed.project.name,
          owner: seed.project.owner,
          siteUrl: seed.project.siteUrl,
          repositoryUrl: seed.project.repositoryUrl,
          description: seed.project.description,
        },
      }),
    };
  },
  validate(output, input, ctx) {
    const maxAllowed = input.mode === 'focus' ? 2 : 3;
    if (output.deliverables.length > maxAllowed) {
      return `${input.mode} 模式下最多规划 ${maxAllowed} 份交付物，请精简聚焦最核心的内容。`;
    }
    const maxSummaryLen = input.uiLanguage === 'en' ? 380 : 160;
    if (output.summary.trim().length > maxSummaryLen) {
      return `summary 过于冗长（当前 ${output.summary.trim().length} 字），概览左侧只放“1 句总括 + 最多 2 条一行短板”，请精简到 ${maxSummaryLen} 字符以内。`;
    }
    if (INTERNAL_TOKEN_RE.test(output.summary)) {
      return 'summary 是面向用户的白话结论，不能包含 model-x、manual-xxx 等内部编号。';
    }
    const jargonInSummary = output.summary.match(AI_JARGON_AND_CLICHE_RE);
    if (jargonInSummary) {
      return `summary 出现了生硬黑话「${jargonInSummary[0]}」，请改用平时说话的自然大白话。`;
    }
    const seed = loadProjectSeed(ctx.projectId);
    const validQuestions = withProjectDb(ctx.projectId, (db, projectId) => {
      ensureProjectRelationalData(projectId, db);
      const rows = db
        .prepare("SELECT id FROM opengeo_questions WHERE project_id = ? AND status = 'active'")
        .all(projectId) as Array<{ id: string }>;
      return new Set(rows.map((r) => r.id));
    });

    for (const item of output.deliverables) {
      if (item.kind === 'new_content' && SELF_DIARY_TITLE_RE.test(item.title)) {
        return `标题「${item.title}」掉进了“写自测日记”的套娃视角！请彻底站在读者视角起标题（回答读者“我想推广自己的产品，该怎么查、怎么改”）。`;
      }
      if (item.questionIds.some((qid) => !validQuestions.has(qid))) {
        return `deliverable「${item.title}」关联了不存在或非核心的问题 ID，请使用 list_project_questions 返回的真实 questionId。`;
      }
      if (item.kind === 'update_asset') {
        if (!item.targetAssetId) return `修改已有资料「${item.title}」时必须填写 targetAssetId。`;
        const asset = seed.assets.find((a) => a.id === item.targetAssetId);
        if (!asset || resolveAssetOwnership(asset, seed).ownership !== 'owned') {
          return `targetAssetId（${item.targetAssetId}）不是当前项目的可编辑自有资料。`;
        }
      }
    }
    return null;
  },
};

export interface WriterInput {
  deliverable: z.infer<typeof plannedDeliverableSchema>;
  targetQuestions: Array<{ id: string; queryZh: string; queryEn: string }>;
  beforeContent: string;
  targetLanguage?: 'en' | 'zh';
  referenceWinners?: ReferenceWinner[];
  draftToRevise?: string;
  revisionFeedback?: string[];
}

export const writerOutputSchema = z.object({
  title: z.string().min(4).max(200),
  afterContent: z.string().min(200),
  mediaManifest: z
    .array(
      z.object({
        type: z.enum(['screenshot', 'mermaid', 'table']),
        pathOrTitle: z.string().min(1),
        caption: z.string().min(2),
      }),
    )
    .min(1),
});

export type WriterOutput = z.infer<typeof writerOutputSchema>;

function extractReferencedImages(content: string): string[] {
  const paths: string[] = [];
  for (const m of content.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    paths.push(m[1]);
  }
  for (const m of content.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
    paths.push(m[1]);
  }
  return paths;
}

const ZH_ONLY_SCREENSHOT_RE = /(?:^|[\\/])(?:overview|question-answer|improvement-tracking)\.png$/i;

const EN_UI_SCREENSHOT_RE = /(?:^|[\\/])(?:overview|question-answer|improvement-tracking)-en\.png$/i;

const EN_AI_SLOP_RE =
  /\b(?:delve into|rich tapestry|testament to|in today['’]s rapidly evolving|in the ever-evolving landscape|unlock the power of|game[- ]changer|seamless synergy)\b/i;

export const deliverableWriterAgent: AgentSpec<WriterInput, WriterOutput> = {
  id: 'deliverable-writer',
  title: '旗舰图文主笔',
  role: 'default',
  maxTurns: skillParams.writer.maxTurns,
  temperature: skillParams.writer.temperature,
  maxTokens: skillParams.writer.maxTokens,
  outputSchema: writerOutputSchema,
  tools: (input) =>
    input.draftToRevise
      ? []
      : createProjectInspectionTools({ targetLanguage: input.targetLanguage }),
  buildPrompt(input, ctx) {
    const seed = loadProjectSeed(ctx.projectId);
    const targetLanguage = input.targetLanguage ?? seed.project.targetLanguage ?? 'en';
    const availableMedia = listAvailableProjectMedia(ctx.projectId, { targetLanguage }).map((m) => ({
      embedPath: formatMediaPathForDestination(m, input.deliverable.destination),
      captionHint: m.captionHint,
    }));
    const scenario = resolveProjectScenario(ctx.projectId);
    const commonPrompt = readAgentText('improvement-planning', 'common-writer.md');
    const archetypeFile = resolveWriterArchetypeFile(scenario, input.deliverable);
    const archetypePrompt = readAgentText('improvement-planning', archetypeFile);
    const languageDirective =
      targetLanguage === 'en'
        ? [
            '## OUTPUT LANGUAGE & VISUAL REQUIREMENT (targetLanguage = en)',
            '- Write `title`, `afterContent`, and `mediaManifest[].caption` 100% in natural, crisp developer English (ZERO Chinese characters anywhere in `title`, headings, prose, tables, Mermaid labels, or captions; ONLY an optional `[简体中文](README.zh-CN.md)` / `[简体中文](getting-started.zh-CN.md)` language switcher link may contain 简体中文).',
            '- When `availableMedia` includes English UI screenshots (`*-en.png`), embed the relevant ones naturally in walkthrough / How-it-works / setup sections using the exact `embedPath` (`README.md` may also keep `<img src="docs/images/opengeo-logo.png" width="80" height="80" alt="OpenGEO" />`). Never embed Chinese-UI `overview.png`, `question-answer.png`, or `improvement-tracking.png` in English drafts.',
            '- Avoid English AI-slop clichés (`delve into`, `rich tapestry`, `testament to`, `in today’s rapidly evolving`, `game-changer`, `unlock the power of`).',
          ].join('\n')
        : '';
    return {
      system: [commonPrompt, archetypePrompt, languageDirective].filter(Boolean).join('\n\n'),
      user: JSON.stringify({
        targetLanguage,
        project: {
          name: seed.project.name,
          owner: seed.project.owner,
          siteUrl: seed.project.siteUrl,
          repositoryUrl: seed.project.repositoryUrl,
        },
        availableMedia,
        referenceWinners: (input.referenceWinners ?? []).map((w) => ({
          domain: w.domain,
          title: w.title,
          probeStatus: w.probeStatus,
          headings: w.headings,
          openingParagraphs: w.openingParagraphs,
          localSnippet: w.localSnippet,
        })),
        deliverablePlan: input.deliverable,
        questionsToAddress: input.targetQuestions.map((q) =>
          targetLanguage === 'en' ? q.queryEn || q.queryZh : q.queryZh || q.queryEn,
        ),
        ...(input.beforeContent ? { existingContentToEnhance: input.beforeContent } : {}),
        ...(input.draftToRevise ? { draftToRevise: input.draftToRevise } : {}),
        ...(input.revisionFeedback?.length
          ? { reviewerRevisionInstructions: input.revisionFeedback }
          : {}),
      }),
    };
  },
  validate(output, input, ctx) {
    const targetLanguage = input.targetLanguage;
    if (input.deliverable.kind === 'new_content' && SELF_DIARY_TITLE_RE.test(output.title)) {
      return `标题「${output.title}」仍是自测日记视角，请改成直接面向读者推广自身产品的实用标题。`;
    }
    if (targetLanguage === 'en') {
      const contentWithoutZhSwitch = output.afterContent.replace(
        /\[[^\]]{1,24}\]\([^)\s]*\.zh-CN\.md\)|<a\s[^>]*href=["'][^"']*\.zh-CN\.md["'][^>]*>[^<]{1,24}<\/a>/gi,
        '',
      );
      const hanMatches = [
        ...(output.title.match(/[\p{Script=Han}]+/gu) ?? []),
        ...(contentWithoutZhSwitch.match(/[\p{Script=Han}]+/gu) ?? []),
      ];
      if (hanMatches.length > 0) {
        const samples = Array.from(new Set(hanMatches)).slice(0, 6).join('", "');
        return `English deliverable (targetLanguage=en) contains Chinese characters ("${samples}"); translate or remove those exact tokens so title and afterContent contain 0 Chinese characters (only an optional [简体中文](*.zh-CN.md) switcher link is allowed).`;
      }
      const slopMatch = output.afterContent.match(EN_AI_SLOP_RE);
      if (slopMatch) {
        return `English deliverable contains AI-slop phrase "${slopMatch[0]}"; rewrite in crisp, direct developer English.`;
      }
    }
    const tokenMatch = output.afterContent.match(INTERNAL_TOKEN_RE);
    if (tokenMatch) {
      return `成稿正文混入了内部工程标识符「${tokenMatch[0]}」，请彻底改为面向读者的自然表述。`;
    }
    const tailMatch = output.afterContent.match(LEGACY_DEFENSIVE_TAIL_RE);
    if (tailMatch) {
      return `成稿混入了旧文档的生硬套话或免责尾巴「${tailMatch[0]}」，请彻底删掉，改用自然平实的人话。`;
    }
    const jargonMatch = output.afterContent.match(AI_JARGON_AND_CLICHE_RE);
    if (jargonMatch) {
      return `成稿出现了 AI 味黑话或端架子金句「${jargonMatch[0]}」，正常读者读起来很费劲，请改成平时跟朋友面对面交流的大白话。`;
    }
    if (/icon(?:-50|-100)?\.png/i.test(output.afterContent)) {
      return '请勿引用旧应用图标 icon.png，只使用 availableMedia 中的真实界面截图。';
    }
    if (/(?:10\s*[~～到至-]\s*15\s*道题|准备几道题[\s\S]{0,30}10)/.test(output.afterContent)) {
      return 'OpenGEO 新建项目时会自动读懂产品并精选最多 8 道核心监测问题，严禁编造“让用户自己准备 10~15 道题”！';
    }
    if (/readme/i.test(input.deliverable.destination)) {
      const bodyBeforeFooter = output.afterContent.slice(
        0,
        Math.max(0, output.afterContent.length - 220),
      );
      if (
        /(?:在\s*ChatGPT\s*里问|去\s*ChatGPT\s*搜|多半会介绍\s*opengeo\.work|省得你走错门)/i.test(
          bodyBeforeFooter,
        )
      ) {
        return 'README 正文前部严禁抱怨或展开“在 ChatGPT 里搜我们会搜出别的同名项目”，同名无隶属声明只能放在全篇最底部一行！';
      }
    }
    if (!isDedicatedTechSetupDoc(input.deliverable.destination)) {
      const techMatch = output.afterContent.match(TECH_SETUP_SCARE_RE);
      if (techMatch) {
        return `面向真人读者的文章出现了劝退用户的技术安装细节「${techMatch[0]}」！请分清“给真人读”与“给用户的 AI 读”：彻底删掉命令行代码块、Node 版本和端口号，改为让读者直接把仓库链接发给自己的 AI 助手帮忙装好跑起来。`;
      }
    }
    const referencedImages = extractReferencedImages(output.afterContent);
    for (const imgPath of referencedImages) {
      if (targetLanguage === 'en' && ZH_ONLY_SCREENSHOT_RE.test(imgPath)) {
        return `英文成稿严禁嵌入中文界面截图「${imgPath}」，请改用英文界面截图（*-en.png）或纯英文 Markdown 对比表/流程图。`;
      }
      if (!localMediaPathExists(ctx.projectId, imgPath, input.deliverable.destination)) {
        return `成稿引用了不存在的图片路径「${imgPath}」，请只使用 availableMedia 中与当前目标文件位置匹配的真实 embedPath。`;
      }
    }
    const availableMedia = listAvailableProjectMedia(ctx.projectId, { targetLanguage });
    const availableScreenshots = availableMedia.filter((m) => !/logo/i.test(m.embedPath));
    if (
      availableScreenshots.length > 0 &&
      input.deliverable.kind === 'update_asset' &&
      referencedImages.length === 0
    ) {
      return '项目已有真实产品界面截图，请在讲实操步骤时自然嵌入 2~3 张真实配图，避免纯文字墙。';
    }
    const hasMarkdownTable = /\|.+\|\r?\n\|[\s:|-]+\|/.test(output.afterContent);
    const hasHtmlTable = /<table[\s>]/i.test(output.afterContent);
    if (!hasMarkdownTable && !hasHtmlTable) {
      return '成稿缺少读者可直接对照使用的结构化表格，请补充至少 1 张实用对照表。';
    }
    if (input.deliverable.kind === 'update_asset' && output.afterContent.trim() === input.beforeContent.trim()) {
      return '修改后的成稿与修改前原文完全相同，未产生有效改进。';
    }
    return null;
  },
};

export interface ReviewerInput {
  kind: 'update_asset' | 'new_content';
  format: 'rich_markdown' | 'web_html';
  title: string;
  destination: string;
  audienceAndGoal: string;
  beforeContent: string;
  afterContent: string;
  targetLanguage?: 'en' | 'zh';
}

const redLineSchema = z.object({
  passed: z.boolean(),
  note: z.string().min(4).max(1000),
});

export const reviewerOutputSchema = z.object({
  verdict: z.enum(['pass', 'veto']),
  summary: z.string().min(6).max(1000),
  checks: z.object({
    authenticity: redLineSchema,
    compliance: redLineSchema,
    readability: redLineSchema,
  }),
  revisionInstructions: z.array(z.string().min(4).max(800)).max(5),
});

export type ReviewerOutput = z.infer<typeof reviewerOutputSchema>;

export const deliverableReviewerAgent: AgentSpec<ReviewerInput, ReviewerOutput> = {
  id: 'deliverable-reviewer',
  title: '三红线独立审核官',
  role: 'default',
  maxTurns: skillParams.reviewer.maxTurns,
  temperature: skillParams.reviewer.temperature,
  outputSchema: reviewerOutputSchema,
  buildPrompt(input, ctx) {
    const seed = loadProjectSeed(ctx.projectId);
    const ownedAssets = seed.assets
      .filter((a) => resolveAssetOwnership(a, seed).ownership === 'owned')
      .map((a) => ({ title: a.title, publicUrl: a.publicUrl }));
    const validMediaPaths = listAvailableProjectMedia(ctx.projectId, {
      targetLanguage: input.targetLanguage,
    }).map((m) => formatMediaPathForDestination(m, input.destination));
    const reviewerPrompt = readAgentText('improvement-planning', 'common-reviewer.md');
    return {
      system: reviewerPrompt,
      user: JSON.stringify({
        targetLanguage: input.targetLanguage ?? seed.project.targetLanguage ?? 'en',
        project: {
          name: seed.project.name,
          owner: seed.project.owner,
          siteUrl: seed.project.siteUrl,
          repositoryUrl: seed.project.repositoryUrl,
          ownedAssets,
          validMediaPaths,
        },
        deliverable: {
          kind: input.kind,
          format: input.format,
          title: input.title,
          destination: input.destination,
          audienceAndGoal: input.audienceAndGoal,
          ...(input.beforeContent ? { beforeContent: input.beforeContent } : {}),
          afterContent: input.afterContent,
        },
      }),
    };
  },
  validate(output) {
    const allPassed =
      output.checks.authenticity.passed &&
      output.checks.compliance.passed &&
      output.checks.readability.passed;
    if (output.verdict === 'pass' && !allPassed) {
      return '存在未通过的红线检查项时，verdict 不能为 pass。';
    }
    if (output.verdict === 'veto' && allPassed) {
      return '三条红线全部通过时，verdict 必须为 pass，不得无故退回。';
    }
    if (output.verdict === 'veto' && output.revisionInstructions.length === 0) {
      return '退回修订（veto）时必须在 revisionInstructions 给出具体修改说明。';
    }
    if (output.verdict === 'pass' && output.revisionInstructions.length > 0) {
      return '审核通过（pass）时 revisionInstructions 应为空数组 []。';
    }
    return null;
  },
};

export interface ChineseCompanionInput {
  title: string;
  destination: string;
  audienceAndGoal: string;
  englishContent: string;
  companionPath: string;
  isRepoDoc: boolean;
}

export const chineseCompanionOutputSchema = z.object({
  content: z.string().min(40),
});

export type ChineseCompanionOutput = z.infer<typeof chineseCompanionOutputSchema>;

export const chineseCompanionAgent: AgentSpec<ChineseCompanionInput, ChineseCompanionOutput> = {
  id: 'chinese-companion-writer',
  title: '中文对照与发布译写官',
  role: 'default',
  maxTurns: skillParams.writer.maxTurns,
  temperature: skillParams.writer.temperature,
  maxTokens: skillParams.writer.maxTokens,
  outputSchema: chineseCompanionOutputSchema,
  buildPrompt(input, ctx) {
    const seed = loadProjectSeed(ctx.projectId);
    const zhMedia = listAvailableProjectMedia(ctx.projectId, { targetLanguage: 'zh' }).map((m) => ({
      embedPath: formatMediaPathForDestination(m, input.companionPath),
      captionHint: m.captionHint,
    }));
    const systemPrompt = [
      '你是 OpenGEO 的双语产品编辑，负责把已通过审核的英文交付稿重写成地道、克制、可直接阅读或发布到国内技术社区（如知乎、掘金、公众号）或中文仓库文档的简体中文版。',
      '要求：',
      '1. 忠实保留英文原稿的事实、数据、表格结构、Mermaid 流程图、仓库链接与真实产品能力，绝不编造新数字、未实现的命令行参数、虚假承诺或 AI 套话。',
      '2. 用真人程序员/独立开发者的自然中文表达，避免生硬机翻腔；专有名词（如 OpenGEO、ChatGPT、Google AI Overviews、Markdown、SQLite）保留英文原称。',
      '3. 若原文中嵌入了英文界面截图（`*-en.png`），必须在中文版里替换为 `availableMedia` 中对应的中文界面截图 `embedPath`（如 `overview.png`、`question-answer.png`、`improvement-tracking.png`）；图片路径必须匹配 `companionPath` 所在目录的相对路径。`opengeo-logo.png` 等中性 logo 保持合法相对路径。',
      input.isRepoDoc
        ? '4. 当前稿件用于 GitHub 仓库中文同步文件：请在顶部保留语言切换链接（例如 `README.zh-CN.md` 指向 `[English](README.md)`，`docs/getting-started.zh-CN.md` 指向 `[English](getting-started.md)`），正文里的相对文档链接也应自然对应到中文版（如 `./docs/getting-started.zh-CN.md` 或 `../README.zh-CN.md`）。'
        : '4. 当前稿件为中文对照阅读及中文平台另发版本，可直接用流畅的中文长文结构输出，不要添加多余的元说明或翻译腔按语。',
    ].join('\n');

    return {
      system: systemPrompt,
      user: JSON.stringify({
        project: {
          name: seed.project.name,
          owner: seed.project.owner,
          siteUrl: seed.project.siteUrl,
          repositoryUrl: seed.project.repositoryUrl,
        },
        companionPath: input.companionPath,
        isRepoDoc: input.isRepoDoc,
        availableMedia: zhMedia,
        deliverable: {
          title: input.title,
          destination: input.destination,
          audienceAndGoal: input.audienceAndGoal,
        },
        englishContent: input.englishContent,
      }),
    };
  },
  validate(output, input, ctx) {
    const hanCount = (output.content.match(/[\p{Script=Han}]/gu) ?? []).length;
    if (hanCount < 12) {
      return '生成的中文对照版包含的中文内容过少，请输出完整流畅的简体中文成稿。';
    }
    const referencedImages = extractReferencedImages(output.content);
    for (const imgPath of referencedImages) {
      if (EN_UI_SCREENSHOT_RE.test(imgPath)) {
        return `中文对照版请使用对应的中文界面截图，不要继续引用英文截图「${imgPath}」。`;
      }
      if (!localMediaPathExists(ctx.projectId, imgPath, input.companionPath)) {
        return `中文对照版引用了不存在的图片路径「${imgPath}」，请使用 availableMedia 中与当前路径匹配的 embedPath。`;
      }
    }
    return null;
  },
};

defaultAgentHub
  .register(optimizationStrategistAgent)
  .register(deliverableWriterAgent)
  .register(deliverableReviewerAgent)
  .register(chineseCompanionAgent);

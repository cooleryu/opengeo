import { z } from 'zod';
import { defaultAgentHub, type AgentSpec } from '../../agent-hub';
import { isProjectOwnedUrl } from '../asset-ownership';
import { withProjectDb } from '../db/schema';
import { loadProjectSeed } from '../project-data';

export interface AnswerAuditorInput {
  query: string;
  answerText: string;
  citationSource: 'native' | 'unknown' | 'none';
  citationsComplete: boolean;
  nativeCitations: Array<{ title: string; url: string }>;
}

export const answerAuditorOutputSchema = z.object({
  identity: z.enum([
    'matched',
    'personal_memory',
    'excluded',
    'unrecognized',
    'ambiguous',
    'absent',
  ]),
  mention: z.enum(['yes', 'no', 'unknown']),
  citation: z.enum(['yes', 'no', 'unknown']),
  mentionQuote: z.string(),
  mentionEvidence: z.string().min(1),
  citationEvidence: z.string().min(1),
  officialUrls: z.array(z.string()),
});

export type AnswerAuditorOutput = z.infer<typeof answerAuditorOutputSchema>;

const PERSONAL_MEMORY_CUE = /(?:你在做的|你正在做的|你的项目|你提到的|结合你|用于你的)/u;

function normInlineWs(value: string): string {
  return value.replace(/[\u00a0\u2000-\u200b\ufeff]/gu, ' ');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadPublishedUrlsForProject(
  projectId: string,
  assets: Array<{ status?: string; publicUrl?: string | null }>,
): string[] {
  const urls = new Set(
    assets
      .filter((asset) => asset.status === 'published' && typeof asset.publicUrl === 'string' && asset.publicUrl)
      .map((asset) => asset.publicUrl!),
  );
  try {
    withProjectDb(projectId, (db, id) => {
      const rows = db
        .prepare(
          'SELECT applied_record_json FROM opengeo_deliverables WHERE project_id = ? AND applied_record_json IS NOT NULL',
        )
        .all(id) as Array<{ applied_record_json: string }>;
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.applied_record_json) as { publishedUrl?: unknown };
          if (typeof parsed?.publishedUrl === 'string' && parsed.publishedUrl) {
            urls.add(parsed.publishedUrl);
          }
        } catch {
          // Ignore malformed rows
        }
      }
    });
  } catch {
    // Allow running without initialized relational DB
  }
  return [...urls];
}

function isOwnedOrAuthoredUrl(
  rawUrl: string,
  project: { siteUrl?: string | null; repositoryUrl?: string | null; owner?: string | null },
  publishedUrls: string[],
): boolean {
  if (
    isProjectOwnedUrl(rawUrl, {
      repositoryUrl: project?.repositoryUrl ?? '',
      siteUrl: project?.siteUrl ?? '',
    })
  ) {
    return true;
  }
  if (publishedUrls.includes(rawUrl)) return true;
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'github.com' || host === 'raw.githubusercontent.com') return false;
    const repoParts = project.repositoryUrl ? new URL(project.repositoryUrl).pathname.split('/').filter(Boolean) : [];
    const owner = (project.owner?.trim() || (repoParts.length >= 2 ? repoParts[0] : '')).trim();
    if (owner.length < 2) return false;
    const ownerRe = escapeRegExp(owner);
    return (
      new RegExp(`/(?:@|u/|user/|users/)?${ownerRe}(?:/|$)`, 'i').test(parsed.pathname) ||
      host.startsWith(`${owner.toLowerCase()}.`)
    );
  } catch {
    return false;
  }
}

export const answerAuditorAgent: AgentSpec<AnswerAuditorInput, AnswerAuditorOutput> = {
  id: 'answer-auditor',
  title: '搜索回答语义阅卷官',
  role: 'fast',
  maxTurns: 3,
  temperature: 0,
  outputSchema: answerAuditorOutputSchema,
  buildPrompt(input, ctx) {
    const seed = loadProjectSeed(ctx.projectId);
    const publishedUrls = loadPublishedUrlsForProject(ctx.projectId, seed.assets);
    return {
      system: [
        '你是客观严谨的 AI 搜索曝光阅卷官，站在“完全陌生的潜在客户”视角判断回答是否真正自然推荐/识别了目标项目。',
        '硬性判卷准则（只要回答正文完整，mention 与 citation 一律给出 yes 或 no，不要留成 unknown）：',
        '1. 同名异义排除：若回答提到的同名产品指向其他域名、插件或组织（非目标仓库/官网），identity 填 excluded，mention 填 no。',
        '2. 否定/不知情/模糊指代：若回答说“我不了解该项目”，identity 填 unrecognized，mention 填 no；若提及名称但称存在多个同名项目或未指向本项目的仓库/作者，identity 填 ambiguous，mention 必须填 no。',
        '3. 登录态个人记忆排除（极其重要）：若回答仅因聊天记忆顺嘴提到“你在做的某某”、“用于你的某某”，对陌生人并不成立，identity 必须填 personal_memory，且 mention 必须填 no！',
        '4. mentionQuote 必须是回答原文中的逐字原句摘录（absent 时填 ""）。',
        '5. 链接引用独立判断：只要 nativeCitations 中包含目标项目官网、仓库、publishedUrls 或同一所有者发表在外部社区的文章（如 dev.to/<owner>/...），citation 填 yes 并将对应链接填入 officialUrls；否则即使未抓全全部悬浮角标，只要这些候选链接里没有你的自有页面或为空，citation 一律填 no（officialUrls 为 []）。',
      ].join('\n'),
      user: JSON.stringify({
        targetProject: {
          name: seed.project.name,
          owner: seed.project.owner,
          siteUrl: seed.project.siteUrl,
          repositoryUrl: seed.project.repositoryUrl,
          publishedUrls,
          description: seed.project.description,
        },
        query: input.query,
        answerText: input.answerText,
        citationSource: input.citationSource,
        citationsComplete: input.citationsComplete,
        nativeCitations: input.nativeCitations,
      }),
    };
  },
  validate(output, input, ctx) {
    const seed = loadProjectSeed(ctx.projectId);
    const publishedUrls = loadPublishedUrlsForProject(ctx.projectId, seed.assets);
    if (output.mentionQuote && !normInlineWs(input.answerText).includes(normInlineWs(output.mentionQuote))) {
      return 'mentionQuote 必须是回答正文中的逐字子串。';
    }
    if (
      output.identity === 'personal_memory' ||
      (output.mentionQuote && PERSONAL_MEMORY_CUE.test(output.mentionQuote))
    ) {
      if (output.mention !== 'no') {
        return '检测到“你在做的…”等个人记忆提及，不属于陌生用户自然曝光，mention 必须判为 no，identity 填 personal_memory。';
      }
    }
    if (output.mention === 'yes' && output.identity !== 'matched') {
      return '确认自然提及（mention=yes）时，identity 必须为 matched。';
    }
    if (output.mention === 'yes' && !output.mentionQuote.trim()) {
      return '确认自然提及时必须提供逐字摘录 mentionQuote。';
    }
    if (output.citation === 'yes') {
      const nativeSet = new Set(input.nativeCitations.map((c) => c.url));
      if (
        !output.officialUrls.length ||
        output.officialUrls.some(
          (url) => !nativeSet.has(url) || !isOwnedOrAuthoredUrl(url, seed.project, publishedUrls),
        )
      ) {
        return 'citation=yes 时 officialUrls 必须非空且全部属于 nativeCitations 中的本项目自有或同所有者发布地址。';
      }
    } else if (output.officialUrls.length > 0) {
      return '未确认引用时 officialUrls 必须为空数组。';
    }
    return null;
  },
};

defaultAgentHub.register(answerAuditorAgent);

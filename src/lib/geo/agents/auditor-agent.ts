import { z } from 'zod';
import { defaultAgentHub, type AgentSpec } from '../../agent-hub';
import { isProjectOwnedUrl } from '../asset-ownership';
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

export const answerAuditorAgent: AgentSpec<AnswerAuditorInput, AnswerAuditorOutput> = {
  id: 'answer-auditor',
  title: '搜索回答语义阅卷官',
  role: 'fast',
  maxTurns: 3,
  temperature: 0,
  outputSchema: answerAuditorOutputSchema,
  buildPrompt(input, ctx) {
    const seed = loadProjectSeed(ctx.projectId);
    return {
      system: [
        '你是客观严谨的 AI 搜索曝光阅卷官，站在“完全陌生的潜在客户”视角判断回答是否真正自然推荐/识别了目标项目。',
        '硬性判卷准则：',
        '1. 同名异义排除：若回答提到的同名产品指向其他域名、插件或组织（非目标仓库/官网），identity 填 excluded，mention 填 no。',
        '2. 否定/不知情排除：若回答说“我不了解该项目”，identity 填 unrecognized，mention 填 no。',
        '3. 登录态个人记忆排除（极其重要）：若回答仅因聊天记忆顺嘴提到“你在做的某某”、“用于你的某某”，对陌生人并不成立，identity 必须填 personal_memory，且 mention 必须填 no！',
        '4. mentionQuote 必须是回答原文中的逐字原句摘录（absent 时填 ""）。',
        '5. 只有 citationSource === "native" 且 nativeCitations 中包含目标项目官方地址时，citation 才能填 yes，并把对应官方链接填入 officialUrls。',
      ].join('\n'),
      user: JSON.stringify({
        targetProject: {
          name: seed.project.name,
          owner: seed.project.owner,
          siteUrl: seed.project.siteUrl,
          repositoryUrl: seed.project.repositoryUrl,
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
    if (output.mentionQuote && !input.answerText.includes(output.mentionQuote)) {
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
    if (input.citationSource !== 'native' && output.citation !== 'unknown') {
      return '缺少平台原生引用清单时，citation 必须保留为 unknown。';
    }
    if (output.citation === 'yes') {
      const nativeSet = new Set(input.nativeCitations.map((c) => c.url));
      if (
        !output.officialUrls.length ||
        output.officialUrls.some(
          (url) => !nativeSet.has(url) || !isProjectOwnedUrl(url, seed.project),
        )
      ) {
        return 'citation=yes 时 officialUrls 必须非空且全部属于 nativeCitations 中的本项目自有地址。';
      }
    } else if (output.officialUrls.length > 0) {
      return '未确认引用时 officialUrls 必须为空数组。';
    }
    return null;
  },
};

defaultAgentHub.register(answerAuditorAgent);

import type { ResearchBatch, ResearchObservation, ResearchQuestion } from '../research-types';
import type { OptimizationDeliverable } from './types';

export interface CodingAgentEvidenceBriefParams {
  projectName?: string;
  repositoryUrl?: string;
  siteUrl?: string;
  deliverable: OptimizationDeliverable;
  batch?: ResearchBatch | null;
  targetLanguage?: 'en' | 'zh';
}

function pickLatestObservation(
  question: ResearchQuestion,
  engine: 'chatgpt' | 'google',
  lang?: 'en' | 'zh',
): ResearchObservation | undefined {
  const candidates = question.observations.filter((o) => o.engine === engine);
  if (!candidates.length) return undefined;
  const scoped = lang ? candidates.filter((o) => o.language === lang) : candidates;
  const pool = scoped.length > 0 ? scoped : candidates;
  return [...pool].sort(
    (a, b) => Date.parse(b.recordedAt || '') - Date.parse(a.recordedAt || ''),
  )[0];
}

export function buildCodingAgentEvidenceBrief(
  params: CodingAgentEvidenceBriefParams,
): string {
  const { projectName, repositoryUrl, siteUrl, deliverable, batch, targetLanguage } = params;
  const lines: string[] = [
    `# AI Visibility Brief: ${deliverable.title}`,
    '',
    '## Target & Goal',
    `- Project: ${projectName?.trim() || 'Current project'}`,
    ...(repositoryUrl ? [`- Repository: ${repositoryUrl}`] : []),
    ...(siteUrl ? [`- Website: ${siteUrl}`] : []),
    `- Target file / channel: \`${deliverable.destination}\` (${deliverable.kind === 'update_asset' ? 'update existing file' : 'new content'})`,
    ...(deliverable.audienceAndGoal ? [`- Goal: ${deliverable.audienceAndGoal}`] : []),
    '',
  ];

  const allQuestions = [
    ...(batch?.questions ?? []),
    ...(batch?.deferredQuestions ?? []),
  ];
  const questionMap = new Map(allQuestions.map((q) => [q.id, q]));
  const audits = batch?.answerAudits ?? [];

  lines.push('## Target Buyer Prompts & Latest AI Search Receipts');
  if (!deliverable.questionIds.length || !batch) {
    lines.push('- No measured question receipts attached yet.');
  } else {
    for (const qId of deliverable.questionIds) {
      const q = questionMap.get(qId);
      if (!q) continue;
      const promptText =
        targetLanguage === 'zh' ? q.zh || q.en : q.en || q.zh;
      lines.push(`### Prompt: "${promptText}"`);
      let anyObs = false;
      for (const engine of ['chatgpt', 'google'] as const) {
        const obs = pickLatestObservation(q, engine, targetLanguage);
        if (!obs) continue;
        anyObs = true;
        const audit = audits.find(
          (a) =>
            a.questionId === q.id &&
            a.engine === engine &&
            a.language === obs.language,
        ) ?? audits.find((a) => a.questionId === q.id && a.engine === engine);
        const engineName = engine === 'chatgpt' ? 'ChatGPT' : 'Google AI';
        const mentionLabel = audit ? audit.mention : obs.status === 'found' ? 'yes' : 'no';
        const citationLabel = audit ? audit.citation : 'unknown';
        const snippet = (audit?.mentionEvidence || obs.summary || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 280);
        lines.push(
          `- **${engineName}** (\`${obs.language}\`): mention=\`${mentionLabel}\`, citation=\`${citationLabel}\`${snippet ? ` — ${snippet}` : ''}`,
        );
        const sources = (obs.sources ?? []).slice(0, 5);
        if (sources.length > 0) {
          lines.push(
            `  - Cited sources: ${sources.map((s) => `[${s.title || s.url}](${s.url})`).join(', ')}`,
          );
        }
      }
      if (!anyObs) {
        lines.push('- Not measured yet on ChatGPT or Google AI.');
      }
      lines.push('');
    }
  }

  const winners = deliverable.referenceWinners ?? [];
  if (winners.length > 0) {
    lines.push('## Cited External Winners Teardown');
    for (const winner of winners) {
      const metaParts = [
        winner.domain,
        ...(typeof winner.stars === 'number' && winner.stars > 0
          ? [`★ ${winner.stars.toLocaleString('en-US')}`]
          : []),
        ...(winner.whyWon ? [winner.whyWon] : []),
      ];
      lines.push(`### [${winner.title}](${winner.url})`);
      lines.push(`- Why it won: ${metaParts.join(' · ')}`);
      if (winner.probeStatus !== 'local_fallback' && winner.headings.length > 0) {
        lines.push(`- Verified H2 skeleton: ${winner.headings.map((h) => `\`${h}\``).join(' → ')}`);
      }
      if (winner.openingParagraphs.length > 0) {
        lines.push(`- Opening structure: ${winner.openingParagraphs[0]}`);
      } else if (winner.localSnippet) {
        lines.push(`- Cited context: ${winner.localSnippet}`);
      }
      lines.push('');
    }
  }

  lines.push('## Guardrails & Verification Checklist');
  lines.push(
    '- Ground every product capability, command, flag, and limitation in real files in this workspace (do not invent unverified metrics or testimonials).',
  );
  lines.push(
    '- Answer buyer questions directly in scannable sections and crisp comparison tables; avoid promotional fluff.',
  );
  lines.push(
    '- After pushing/publishing changes and allowing search/model indexing to refresh, re-run the exact buyer prompts above under the same browser conditions.',
  );

  return `${lines.join('\n').trimEnd()}\n`;
}

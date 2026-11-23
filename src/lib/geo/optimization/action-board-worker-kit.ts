import { defaultAgentHub, type AgentSpec, type LLMTransport } from '../../agent-hub';
import type { ActionBoardWorkerTelemetry, ActionCardPayload, Label } from './action-board-catalog';

export interface WorkerRunOptions {
  projectId: string;
  targetLanguage: 'en' | 'zh';
  transport?: LLMTransport;
  signal?: AbortSignal;
}

export interface WorkerResult {
  payload: ActionCardPayload;
  telemetry: ActionBoardWorkerTelemetry;
  why?: Label;
}

export const FACT_RULES = [
  'Truthfulness rules:',
  '- Ground every product feature, setup step, license and limitation in `ctx.project.factsExcerpt` and `ctx.project`.',
  '- Use the exact brand capitalization of `ctx.project.name`.',
  '- Never invent star counts, benchmarks, testimonials, prices, or URLs. Only use URLs given in the input.',
  '- Never leak internal IDs (project-…, model-…) into any text.',
].join('\n');

export const WHY_RULE = [
  '`whyDoThis` is a required {en, zh} pair for a busy founder: ONE crisp, concrete plain-language sentence on why this action changes what AI answers say.',
  'Name the concrete evidence from the input (e.g. the conflicting project name, top competitors, or the cited platform). Do not restate the card title, no jargon.',
  '`en` 50-120 characters, `zh` 18-48 Chinese characters.',
].join(' ');

/** Every field is typed: Pub fields in the target language, Label pairs in both languages. */
export function languageRules(targetLanguage: 'en' | 'zh'): string {
  const target = targetLanguage === 'en' ? 'natural English for global readers' : 'natural Simplified Chinese';
  return [
    'Language rules (decided by the field, never by you):',
    `- Publishable fields (everything that is not an {en, zh} object) are written in ${target}.`,
    '- Label fields are {en, zh} objects: `en` in plain English, `zh` in plain Simplified Chinese, same meaning, short.',
    '- Never put Chinese into a publishable English field or English sentences into a `zh` label.',
  ].join('\n');
}

export function emptyTelemetry(agentId: string, source: ActionBoardWorkerTelemetry['source']): ActionBoardWorkerTelemetry {
  return { agentId, model: source === 'deterministic' ? 'code' : '', promptTokens: 0, completionTokens: 0, durationMs: 0, source };
}

export async function runWorker<TIn, TOut>(
  spec: AgentSpec<TIn, TOut>,
  input: TIn,
  opts: WorkerRunOptions,
): Promise<{ output: TOut; telemetry: ActionBoardWorkerTelemetry }> {
  const startedAt = Date.now();
  const result = await defaultAgentHub.run(spec, input, {
    projectId: opts.projectId,
    transport: opts.transport,
    signal: opts.signal,
  });
  return {
    output: result.output,
    telemetry: {
      agentId: spec.id,
      model: result.model,
      promptTokens: result.telemetry?.promptTokens ?? 0,
      completionTokens: result.telemetry?.completionTokens ?? 0,
      durationMs: Date.now() - startedAt,
      source: 'llm',
    },
  };
}

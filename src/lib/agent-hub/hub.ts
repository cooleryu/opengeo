import { repairJson } from '@toolsycc/json-repair';
import { z } from 'zod';
import { createGuardrailInterceptor, createProgressInterceptor, createTelemetryInterceptor, type AgentTelemetrySnapshot } from './interceptors';
import { resolveAgentTransport } from './transport';
import type { AgentInterceptor, AgentRunContext, AgentSpec, ChatMessage, HumanProgressStep, LLMTransport } from './types';

function extractJsonText(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

function parseAgentJson(raw: string): unknown {
  const candidate = extractJsonText(raw);
  try {
    return JSON.parse(candidate);
  } catch (err) {
    const repaired = repairJson(candidate, { returnObject: true });
    if (repaired && typeof repaired === 'object') {
      return repaired;
    }
    throw err;
  }
}

export interface AgentRunOptions {
  projectId: string;
  transport?: LLMTransport;
  preferredProvider?: 'gemini' | 'deepseek';
  allowWriteTools?: boolean;
  interceptors?: AgentInterceptor[];
  onProgress?: (step: HumanProgressStep) => void;
  signal?: AbortSignal;
}

export interface AgentRunResult<TOutput> {
  output: TOutput;
  model: string;
  progress: HumanProgressStep[];
  telemetry: AgentTelemetrySnapshot;
}

/** Micro-kernel Strategy Registry + Template ReAct Loop + AOP Interceptor Chain. */
export class AgentHub {
  private readonly specs = new Map<string, AgentSpec<any, any>>();

  register<TInput, TOutput>(spec: AgentSpec<TInput, TOutput>): this {
    this.specs.set(spec.id, spec);
    return this;
  }

  get<TInput = unknown, TOutput = unknown>(id: string): AgentSpec<TInput, TOutput> {
    const spec = this.specs.get(id);
    if (!spec) throw new Error(`未注册的 Agent 策略：${id}`);
    return spec;
  }

  async run<TInput, TOutput>(specOrId: string | AgentSpec<TInput, TOutput>, input: TInput, options: AgentRunOptions): Promise<AgentRunResult<TOutput>> {
    const spec = typeof specOrId === 'string' ? this.get<TInput, TOutput>(specOrId) : specOrId;
    const ctx: AgentRunContext = { projectId: options.projectId, signal: options.signal };
    const transport = options.transport ?? resolveAgentTransport(spec.role ?? 'default', options.preferredProvider);
    const progressAspect = createProgressInterceptor(options.onProgress);
    const telemetryAspect = createTelemetryInterceptor();
    const aspects: AgentInterceptor[] = [
      progressAspect.interceptor,
      createGuardrailInterceptor({ expectedProjectId: options.projectId, allowWriteTools: options.allowWriteTools }),
      telemetryAspect.interceptor,
      ...(options.interceptors ?? []),
    ];

    const tools = spec.tools?.(input, ctx) ?? [];
    const toolMap = new Map(tools.map((t) => [t.name, t]));
    const { system, user } = spec.buildPrompt(input, ctx);
    const messages: ChatMessage[] = [
      { role: 'system', content: `${system}\n\n完成后请严格输出符合以下 JSON Schema 的纯 JSON 对象（不要输出额外说明）：\n${JSON.stringify(z.toJSONSchema(spec.outputSchema))}` },
      { role: 'user', content: user },
    ];

    const startedAt = Date.now();
    let toolCallsCount = 0, promptTokens = 0, completionTokens = 0, activeModel = '', corrections = 0, forceJsonOnly = false;
    const maxTurns = spec.maxTurns ?? 6;

    try {
      for (const a of aspects) await a.beforeRun?.({ agentId: spec.id, title: spec.title, projectId: ctx.projectId });

      for (let turn = 1; turn <= maxTurns; turn += 1) {
        const activeTools = !forceJsonOnly && tools.length ? tools : undefined;
        const res = await transport.complete({ messages, tools: activeTools, jsonMode: !activeTools, temperature: spec.temperature ?? 0.2, maxTokens: spec.maxTokens, signal: ctx.signal });
        activeModel = res.model;
        promptTokens += res.promptTokens ?? 0;
        completionTokens += res.completionTokens ?? 0;

        if (res.message.tool_calls?.length) {
          messages.push(res.message);
          for (const call of res.message.tool_calls) {
            const tool = toolMap.get(call.function.name);
            if (!tool) {
              messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: '未知工具' }) });
              continue;
            }
            const parsedArgs = tool.parameters.parse(JSON.parse(call.function.arguments || '{}'));
            for (const a of aspects) await a.beforeToolCall?.({ agentId: spec.id, tool, args: parsedArgs, turn, projectId: ctx.projectId });
            const t0 = Date.now();
            const result = await tool.execute(parsedArgs, ctx);
            toolCallsCount += 1;
            for (const a of aspects) await a.afterToolCall?.({ agentId: spec.id, tool, args: parsedArgs, durationMs: Date.now() - t0, turn });
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
          }
          continue;
        }

        let parsedJson: unknown;
        try { parsedJson = parseAgentJson(res.message.content ?? ''); }
        catch {
          if (corrections < 2 && turn < maxTurns) { corrections += 1; forceJsonOnly = true; messages.push(res.message, { role: 'user', content: '返回内容不是合法 JSON，请只输出纯 JSON 对象。' }); continue; }
          throw new Error('返回结果格式无法解析为有效 JSON。');
        }

        const schemaCheck = spec.outputSchema.safeParse(parsedJson);
        const domainIssue = schemaCheck.success ? spec.validate?.(schemaCheck.data, input, ctx) : null;
        if (!schemaCheck.success || domainIssue) {
          const firstIssue = schemaCheck.error?.issues[0];
          const issueDetail = firstIssue
            ? `${firstIssue.path.join('.') || 'root'}${firstIssue.message ? ` (${firstIssue.message})` : ''}`
            : 'root';
          const reason = domainIssue ?? `字段不符合要求：${issueDetail}`;
          if (corrections < 2 && turn < maxTurns) { corrections += 1; forceJsonOnly = true; messages.push(res.message, { role: 'user', content: `结果未通过确定性校验（${reason}），请修正后重新输出 JSON。` }); continue; }
          throw new Error(`结果未通过确定性校验：${reason}`);
        }

        const totalMs = Date.now() - startedAt;
        for (const a of aspects) await a.afterRun?.({ agentId: spec.id, title: spec.title, model: activeModel, turns: turn, toolCalls: toolCallsCount, totalMs, promptTokens, completionTokens });
        return { output: schemaCheck.data, model: activeModel, progress: progressAspect.steps, telemetry: telemetryAspect.records[0] };
      }
      throw new Error(`超过最大推理轮数（${maxTurns} 轮）仍未收敛。`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : '执行异常';
      for (const a of aspects) await a.onError?.({ agentId: spec.id, title: spec.title, message: msg });
      throw error;
    }
  }
}

export const defaultAgentHub = new AgentHub();

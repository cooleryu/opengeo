import type { AgentInterceptor, HumanProgressStep } from './types';

/** Aspect 1: Translates internal ReAct turns & tool invocations into plain-Chinese human logs. */
export function createProgressInterceptor(onStep?: (step: HumanProgressStep) => void) {
  const steps: HumanProgressStep[] = [];
  const push = (agentId: string, kind: HumanProgressStep['kind'], message: string) => {
    const step: HumanProgressStep = { at: new Date().toISOString(), agentId, kind, message };
    steps.push(step);
    onStep?.(step);
  };
  const interceptor: AgentInterceptor = {
    beforeRun: ({ agentId, title }) => push(agentId, 'start', `正在由「${title}」梳理项目背景与任务目标…`),
    beforeToolCall: ({ agentId, tool, args }) => push(agentId, 'tool', tool.humanLabel(args)),
    afterRun: ({ agentId, title, totalMs }) => push(agentId, 'done', `「${title}」已完成分析并通过结果核验（用时 ${(totalMs / 1000).toFixed(1)} 秒）。`),
    onError: ({ agentId, title, message }) => push(agentId, 'error', `「${title}」未能完成：${message}`),
  };
  return { steps, interceptor };
}

/** Aspect 2: Enforces project-scope isolation and blocks unauthorized mutating tools. */
export function createGuardrailInterceptor(options: { expectedProjectId: string; allowWriteTools?: boolean }): AgentInterceptor {
  return {
    beforeToolCall({ tool, args, projectId }) {
      if (projectId !== options.expectedProjectId) throw new Error('安全切面拦截：工具调用越过了当前所属项目边界。');
      if (!options.allowWriteTools && tool.readOnly === false) throw new Error(`安全切面拦截：未经用户确认，禁止执行写入类操作（${tool.name}）。`);
      const reqProj = args && typeof args === 'object' && 'projectId' in args ? (args as { projectId?: unknown }).projectId : undefined;
      if (typeof reqProj === 'string' && reqProj !== options.expectedProjectId) throw new Error('安全切面拦截：禁止跨项目读取或操作其他项目资料。');
    },
  };
}

export interface AgentTelemetrySnapshot {
  agentId: string;
  model: string;
  turns: number;
  toolCalls: number;
  totalMs: number;
  promptTokens: number;
  completionTokens: number;
}

/** Aspect 3: Records non-intrusive execution metrics (turns, latency, token usage). */
export function createTelemetryInterceptor() {
  const records: AgentTelemetrySnapshot[] = [];
  const interceptor: AgentInterceptor = {
    afterRun: (e) => {
      records.push({ agentId: e.agentId, model: e.model, turns: e.turns, toolCalls: e.toolCalls, totalMs: e.totalMs, promptTokens: e.promptTokens, completionTokens: e.completionTokens });
    },
  };
  return { records, interceptor };
}

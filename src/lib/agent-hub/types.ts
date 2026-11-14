import type { z } from 'zod';

export interface ToolCallRequest {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  [extraKey: string]: unknown;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCallRequest[]; [extraKey: string]: unknown }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface AgentRunContext { projectId: string; signal?: AbortSignal }

export interface AgentTool<TArgs = unknown> {
  name: string;
  description: string;
  parameters: z.ZodType<TArgs>;
  readOnly?: boolean;
  humanLabel: (args: TArgs) => string;
  execute: (args: TArgs, ctx: AgentRunContext) => Promise<unknown> | unknown;
}

export interface LLMCompletionRequest {
  messages: ChatMessage[];
  tools?: AgentTool<any>[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  signal?: AbortSignal;
}

export interface LLMCompletionResult {
  message: Extract<ChatMessage, { role: 'assistant' }>;
  model: string;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
}

export interface LLMTransport {
  readonly provider: string;
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResult>;
}

/** Strategy interface implemented by every business Agent (Planner, Writer, Reviewer, Auditor). */
export interface AgentSpec<TInput, TOutput> {
  id: string;
  title: string;
  role?: 'default' | 'fast';
  maxTurns?: number;
  temperature?: number;
  maxTokens?: number;
  outputSchema: z.ZodType<TOutput>;
  buildPrompt: (input: TInput, ctx: AgentRunContext) => { system: string; user: string };
  tools?: (input: TInput, ctx: AgentRunContext) => AgentTool<any>[];
  validate?: (output: TOutput, input: TInput, ctx: AgentRunContext) => string | null;
}

export interface HumanProgressStep { at: string; agentId: string; kind: 'start' | 'tool' | 'done' | 'retry' | 'error'; message: string }

/** AOP Aspect interface for progress translation, sandbox guardrails, and telemetry. */
export interface AgentInterceptor {
  beforeRun?(e: { agentId: string; title: string; projectId: string }): void | Promise<void>;
  beforeToolCall?(e: { agentId: string; tool: AgentTool<any>; args: unknown; turn: number; projectId: string }): void | Promise<void>;
  afterToolCall?(e: { agentId: string; tool: AgentTool<any>; args: unknown; durationMs: number; turn: number }): void | Promise<void>;
  afterRun?(e: { agentId: string; title: string; model: string; turns: number; toolCalls: number; totalMs: number; promptTokens: number; completionTokens: number }): void | Promise<void>;
  onError?(e: { agentId: string; title: string; message: string }): void | Promise<void>;
}

import type { z } from 'zod';

export type ModelToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ModelToolCall[] }
  | { role: 'tool'; id: string; name: string; content: string };

export type GenerateOptions = {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stopSequences?: string[];
  frequencyPenalty?: number;
  presencePenalty?: number;
};

export type GenerateObjectInput = {
  schema: z.ZodTypeAny;
  messages: Message[];
  options?: GenerateOptions;
  /** Feature-specific clean-up of the parsed JSON, applied before `schema` validation. */
  prepare?: (raw: unknown) => unknown;
};

import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, jsonSchema, NoObjectGeneratedError, Output, type JSONSchema7, type LanguageModel, type ModelMessage } from 'ai';
import { z } from 'zod';
import type { Message } from '@/lib/types';
import type { ModelProviderId } from './providers';
import type { GenerateObjectInput } from './types';

/** The one bridge between OpenGEO and the Vercel AI SDK. Provider quirks live in the SDK packages. */
export type ModelConnection = { provider: ModelProviderId; baseURL: string; apiKey: string; model: string };
export type ModelCallSettings = { fetch?: typeof globalThis.fetch; maxRetries?: number; abortSignal?: AbortSignal };

export function createLanguageModel(connection: ModelConnection, fetch?: typeof globalThis.fetch): LanguageModel {
  const { apiKey, model } = connection;
  const baseURL = connection.baseURL || undefined;
  switch (connection.provider) {
    case 'deepseek': return createDeepSeek({ apiKey, baseURL, fetch })(model);
    case 'openai': return createOpenAI({ apiKey, baseURL, fetch })(model);
    case 'anthropic': return createAnthropic({ apiKey, baseURL, fetch })(model);
    // Older settings saved Gemini's OpenAI-compatible URL; the native SDK uses Google's own endpoint.
    case 'gemini': return createGoogleGenerativeAI({ apiKey, fetch })(model);
    default:
      return createOpenAICompatible({ name: connection.provider, apiKey, baseURL: connection.baseURL, fetch, supportsStructuredOutputs: true })(model);
  }
}

/** Per-provider request switches that keep today's behaviour (DeepSeek answers JSON without thinking). */
export const structuredProviderOptions = {
  deepseek: { deepseek: { thinking: { type: 'disabled' } } },
  openai: { openai: { strictJsonSchema: false } },
} as const;

export function toModelMessages(messages: Message[]): ModelMessage[] {
  return messages.map((message): ModelMessage => message.role === 'tool'
    ? { role: 'tool', content: [{ type: 'tool-result', toolCallId: message.id, toolName: message.name, output: { type: 'text', value: message.content } }] }
    : { role: message.role, content: message.content });
}

export function createStructuredModel(connection: ModelConnection, settings: ModelCallSettings = {}) {
  const model = createLanguageModel(connection, settings.fetch);
  return {
    async generateObject<T>(input: GenerateObjectInput): Promise<T> {
      const cutOff = () => new Error(`Model JSON was cut off (${connection.provider}/${connection.model}); no partial result was accepted.`);
      const result = await generateText({
        model,
        messages: toModelMessages(input.messages),
        allowSystemInMessages: true,
        // Send the shape to the model, but validate here so feature code can clean the raw JSON first.
        output: Output.object({ schema: jsonSchema(z.toJSONSchema(input.schema, { unrepresentable: 'any' }) as JSONSchema7) }),
        temperature: input.options?.temperature,
        topP: input.options?.topP,
        maxOutputTokens: input.options?.maxTokens,
        stopSequences: input.options?.stopSequences,
        frequencyPenalty: input.options?.frequencyPenalty,
        presencePenalty: input.options?.presencePenalty,
        providerOptions: structuredProviderOptions[connection.provider as keyof typeof structuredProviderOptions],
        maxRetries: settings.maxRetries,
        abortSignal: settings.abortSignal,
      }).catch((error: unknown) => {
        // Truncated output is a token-limit problem, not a formatting slip, so it is never retried as one.
        throw NoObjectGeneratedError.isInstance(error) && error.finishReason === 'length' ? cutOff() : error;
      });
      if (result.finishReason === 'length') throw cutOff();
      const raw: unknown = result.output;
      return input.schema.parse(input.prepare ? input.prepare(raw) : raw) as T;
    },
  };
}

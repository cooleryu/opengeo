import OpenAI from 'openai';
import BaseLLM from '../../base/llm';
import { zodTextFormat, zodResponseFormat } from 'openai/helpers/zod';
import {
  GenerateObjectInput,
  GenerateOptions,
  GenerateTextInput,
  GenerateTextOutput,
  StreamTextOutput,
  ToolCall,
} from '../../types';
import { parse } from 'partial-json';
import z from 'zod';
import {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
} from 'openai/resources/index.mjs';
import { Message } from '@/lib/types';
import { repairJson } from '@toolsycc/json-repair';

type OpenAIConfig = {
  apiKey: string;
  model: string;
  baseURL?: string;
  options?: GenerateOptions;
};

class OpenAILLM extends BaseLLM<OpenAIConfig> {
  openAIClient: OpenAI;

  constructor(protected config: OpenAIConfig) {
    super(config);

    this.openAIClient = new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseURL || 'https://api.openai.com/v1',
    });
  }

  convertToOpenAIMessages(messages: Message[]): ChatCompletionMessageParam[] {
    return messages.map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: msg.id,
          content: msg.content,
        } as ChatCompletionToolMessageParam;
      } else if (msg.role === 'assistant') {
        return {
          role: 'assistant',
          content: msg.content,
          ...(msg.tool_calls &&
            msg.tool_calls.length > 0 && {
              tool_calls: msg.tool_calls?.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.arguments),
                },
              })),
            }),
        } as ChatCompletionAssistantMessageParam;
      }

      return msg;
    });
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const openaiTools: ChatCompletionTool[] = [];

    input.tools?.forEach((tool) => {
      openaiTools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: z.toJSONSchema(tool.schema),
        },
      });
    });

    const response = await this.openAIClient.chat.completions.create({
      model: this.config.model,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      messages: this.convertToOpenAIMessages(input.messages),
      temperature:
        input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
      top_p: input.options?.topP ?? this.config.options?.topP,
      max_completion_tokens:
        input.options?.maxTokens ?? this.config.options?.maxTokens,
      stop: input.options?.stopSequences ?? this.config.options?.stopSequences,
      frequency_penalty:
        input.options?.frequencyPenalty ??
        this.config.options?.frequencyPenalty,
      presence_penalty:
        input.options?.presencePenalty ?? this.config.options?.presencePenalty,
    });

    if (response.choices && response.choices.length > 0) {
      return {
        content: response.choices[0].message.content!,
        toolCalls:
          response.choices[0].message.tool_calls
            ?.map((tc) => {
              if (tc.type === 'function') {
                return {
                  name: tc.function.name,
                  id: tc.id,
                  arguments: JSON.parse(tc.function.arguments),
                };
              }
            })
            .filter((tc) => tc !== undefined) || [],
        additionalInfo: {
          finishReason: response.choices[0].finish_reason,
        },
      };
    }

    throw new Error('No response from OpenAI');
  }

  async *streamText(
    input: GenerateTextInput,
  ): AsyncGenerator<StreamTextOutput> {
    const openaiTools: ChatCompletionTool[] = [];

    input.tools?.forEach((tool) => {
      openaiTools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: z.toJSONSchema(tool.schema),
        },
      });
    });

    const stream = await this.openAIClient.chat.completions.create({
      model: this.config.model,
      messages: this.convertToOpenAIMessages(input.messages),
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      temperature:
        input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
      top_p: input.options?.topP ?? this.config.options?.topP,
      max_completion_tokens:
        input.options?.maxTokens ?? this.config.options?.maxTokens,
      stop: input.options?.stopSequences ?? this.config.options?.stopSequences,
      frequency_penalty:
        input.options?.frequencyPenalty ??
        this.config.options?.frequencyPenalty,
      presence_penalty:
        input.options?.presencePenalty ?? this.config.options?.presencePenalty,
      stream: true,
    });

    let recievedToolCalls: { name: string; id: string; arguments: string }[] =
      [];

    for await (const chunk of stream) {
      if (chunk.choices && chunk.choices.length > 0) {
        const toolCalls = chunk.choices[0].delta.tool_calls;
        yield {
          contentChunk: chunk.choices[0].delta.content || '',
          toolCallChunk:
            toolCalls?.map((tc) => {
              if (!recievedToolCalls[tc.index]) {
                const call = {
                  name: tc.function?.name!,
                  id: tc.id!,
                  arguments: tc.function?.arguments || '',
                };
                recievedToolCalls.push(call);
                return { ...call, arguments: parse(call.arguments || '{}') };
              } else {
                const existingCall = recievedToolCalls[tc.index];
                existingCall.arguments += tc.function?.arguments || '';
                return {
                  ...existingCall,
                  arguments: parse(existingCall.arguments),
                };
              }
            }) || [],
          done: chunk.choices[0].finish_reason !== null,
          additionalInfo: {
            finishReason: chunk.choices[0].finish_reason,
          },
        };
      }
    }
  }

  async generateObject<T>(input: GenerateObjectInput): Promise<T> {
    // DeepSeek supports JSON mode, but not OpenAI's json_schema response format.
    if (new URL(this.openAIClient.baseURL).hostname === 'api.deepseek.com') {
      const request = {
        model: this.config.model,
        messages: [
          {
            role: 'system' as const,
            content: `Return only a JSON object, with no markdown or surrounding text. The JSON must satisfy this schema: ${JSON.stringify(z.toJSONSchema(input.schema))}`,
          },
          ...this.convertToOpenAIMessages(input.messages),
        ],
        temperature:
          input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
        top_p: input.options?.topP ?? this.config.options?.topP,
        max_tokens: input.options?.maxTokens ?? this.config.options?.maxTokens,
        stop: input.options?.stopSequences ?? this.config.options?.stopSequences,
        response_format: { type: 'json_object' as const },
        thinking: { type: 'disabled' as const },
      };
      const response = await this.openAIClient.chat.completions.create(request, {
        timeout: 180_000,
        maxRetries: 0,
      });
      const choice = response.choices[0];
      if (!choice?.message.content?.trim()) {
        throw new Error('DeepSeek returned an empty JSON response');
      }
      if (choice.finish_reason !== 'stop') {
        throw new Error(
          `DeepSeek JSON response did not finish normally (${choice.finish_reason}); no partial result was accepted`,
        );
      }
      try {
        const rawParsed = JSON.parse(choice.message.content) as Record<string, unknown>;
        if (Array.isArray(rawParsed?.reviews)) {
          for (const item of rawParsed.reviews) {
            if (!item || typeof item !== 'object') continue;
            const assessment = (item as Record<string, unknown>).assessment as
              | Record<string, unknown>
              | undefined;
            const cs = assessment?.currentSupport as Record<string, unknown> | undefined;
            if (
              assessment &&
              cs &&
              Array.isArray(assessment.evidence) &&
              Array.isArray(cs.evidence)
            ) {
              const seen = new Set(
                assessment.evidence.map(
                  (e: { assetId?: unknown; quote?: unknown }) =>
                    `${String(e?.assetId ?? '')}\0${String(e?.quote ?? '')}`,
                ),
              );
              for (const entry of cs.evidence) {
                const key = `${String((entry as { assetId?: unknown })?.assetId ?? '')}\0${String((entry as { quote?: unknown })?.quote ?? '')}`;
                if (!seen.has(key)) {
                  seen.add(key);
                  assessment.evidence.push(entry);
                }
              }
              delete cs.evidence;
            }
          }
        }
        if (Array.isArray(rawParsed?.selectedIds) && Array.isArray(rawParsed?.coverage)) {
          let userCtx: Record<string, unknown> | undefined;
          try {
            const lastUser = [...input.messages]
              .reverse()
              .find((m) => m.role === 'user');
            if (lastUser && typeof lastUser.content === 'string') {
              userCtx = JSON.parse(lastUser.content) as Record<string, unknown>;
            }
          } catch {
            /* Ignore malformed or non-JSON user prompt */
          }
          const validCandidateIds = new Set<string>();
          const eligibleSelectedIds = new Set<string>();
          if (Array.isArray(userCtx?.candidates)) {
            for (const c of userCtx.candidates) {
              if (!c || typeof c !== 'object') continue;
              const rec = c as Record<string, unknown>;
              if (typeof rec.id !== 'string') continue;
              validCandidateIds.add(rec.id);
              const rev = rec.review as Record<string, unknown> | undefined;
              if (
                rev?.decision === 'include' &&
                rev?.status === 'reviewed' &&
                Boolean(rev?.assessment)
              ) {
                eligibleSelectedIds.add(rec.id);
              }
            }
          }
          const existingNeedIds = new Set<string>();
          if (Array.isArray(userCtx?.needs)) {
            for (const n of userCtx.needs) {
              if (n && typeof n === 'object' && typeof (n as Record<string, unknown>).id === 'string') {
                existingNeedIds.add((n as Record<string, unknown>).id as string);
              }
            }
          }
          const validMaterialIds = new Set<string>();
          if (Array.isArray(userCtx?.materials)) {
            for (const m of userCtx.materials) {
              if (m && typeof m === 'object' && typeof (m as Record<string, unknown>).id === 'string') {
                validMaterialIds.add((m as Record<string, unknown>).id as string);
              }
            }
          }

          const selectedIds = [
            ...new Set(
              rawParsed.selectedIds.filter(
                (id): id is string =>
                  typeof id === 'string' &&
                  (eligibleSelectedIds.size === 0 || eligibleSelectedIds.has(id)),
              ),
            ),
          ];
          const selectedSet = new Set(selectedIds);
          const replacedDuplicate = new Map<string, string>();

          if (Array.isArray(rawParsed.duplicates)) {
            const seenDupKeys = new Set<string>();
            const cleanedDuplicates: Array<Record<string, unknown>> = [];
            for (const group of rawParsed.duplicates) {
              if (!group || typeof group !== 'object') continue;
              const rec = group as Record<string, unknown>;
              if (!Array.isArray(rec.candidateIds)) continue;
              const candidateIds = [
                ...new Set(
                  rec.candidateIds.filter(
                    (id): id is string =>
                      typeof id === 'string' &&
                      (validCandidateIds.size === 0 || validCandidateIds.has(id)),
                  ),
                ),
              ];
              if (candidateIds.length < 2) continue;
              const key = [...candidateIds].sort().join('\u0000');
              if (seenDupKeys.has(key)) continue;
              seenDupKeys.add(key);
              const inSel = candidateIds.filter((id) => selectedSet.has(id));
              if (inSel.length > 1) {
                const kept = inSel[0];
                for (const extra of inSel.slice(1)) {
                  selectedSet.delete(extra);
                  replacedDuplicate.set(extra, kept);
                }
              }
              cleanedDuplicates.push({ ...rec, candidateIds });
            }
            rawParsed.duplicates = cleanedDuplicates;
          }
          rawParsed.selectedIds = selectedIds.filter((id) => selectedSet.has(id));

          const resolveId = (id: string) => {
            let cur = id;
            const visited = new Set<string>();
            while (replacedDuplicate.has(cur) && !visited.has(cur)) {
              visited.add(cur);
              cur = replacedDuplicate.get(cur)!;
            }
            return cur;
          };

          for (const item of rawParsed.coverage) {
            if (!item || typeof item !== 'object') continue;
            const cov = item as Record<string, unknown>;
            if (!Array.isArray(cov.candidateIds)) continue;
            const uniqueIds = [
              ...new Set(
                cov.candidateIds
                  .filter((id): id is string => typeof id === 'string')
                  .map(resolveId),
              ),
            ];
            if (cov.status === 'missing' || cov.status === 'deferred') {
              cov.candidateIds = [];
            } else if (cov.status === 'covered') {
              const inSelected = uniqueIds.filter((id) => selectedSet.has(id));
              cov.candidateIds = inSelected.length > 0 ? inSelected : uniqueIds;
            } else {
              cov.candidateIds = uniqueIds;
            }
          }

          if (Array.isArray(rawParsed.missingAdditionalNeeds)) {
            const seenNeedIds = new Set<string>();
            const cleanedNeeds: Array<Record<string, unknown>> = [];
            for (const need of rawParsed.missingAdditionalNeeds) {
              if (!need || typeof need !== 'object') continue;
              const rec = need as Record<string, unknown>;
              if (
                typeof rec.id !== 'string' ||
                seenNeedIds.has(rec.id) ||
                existingNeedIds.has(rec.id) ||
                rec.importance !== 'high'
              ) {
                continue;
              }
              seenNeedIds.add(rec.id);
              const assetIds = Array.isArray(rec.assetIds)
                ? [
                    ...new Set(
                      rec.assetIds.filter(
                        (id): id is string =>
                          typeof id === 'string' &&
                          (validMaterialIds.size === 0 || validMaterialIds.has(id)),
                      ),
                    ),
                  ]
                : [];
              cleanedNeeds.push({ ...rec, assetIds });
            }
            rawParsed.missingAdditionalNeeds = cleanedNeeds;
          }
        }
        return input.schema.parse(rawParsed) as T;
      } catch (err) {
        throw new Error(`Error parsing response from DeepSeek: ${err}`);
      }
    }

    const response = await this.openAIClient.chat.completions.parse({
      messages: this.convertToOpenAIMessages(input.messages),
      model: this.config.model,
      temperature:
        input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
      top_p: input.options?.topP ?? this.config.options?.topP,
      max_completion_tokens:
        input.options?.maxTokens ?? this.config.options?.maxTokens,
      stop: input.options?.stopSequences ?? this.config.options?.stopSequences,
      frequency_penalty:
        input.options?.frequencyPenalty ??
        this.config.options?.frequencyPenalty,
      presence_penalty:
        input.options?.presencePenalty ?? this.config.options?.presencePenalty,
      response_format: zodResponseFormat(input.schema, 'object'),
    });

    if (response.choices && response.choices.length > 0) {
      try {
        return input.schema.parse(
          JSON.parse(
            repairJson(response.choices[0].message.content!, {
              extractJson: true,
            }) as string,
          ),
        ) as T;
      } catch (err) {
        throw new Error(`Error parsing response from OpenAI: ${err}`);
      }
    }

    throw new Error('No response from OpenAI');
  }

  async *streamObject<T>(input: GenerateObjectInput): AsyncGenerator<T> {
    let recievedObj: string = '';

    const stream = this.openAIClient.responses.stream({
      model: this.config.model,
      input: input.messages,
      temperature:
        input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
      top_p: input.options?.topP ?? this.config.options?.topP,
      max_completion_tokens:
        input.options?.maxTokens ?? this.config.options?.maxTokens,
      stop: input.options?.stopSequences ?? this.config.options?.stopSequences,
      frequency_penalty:
        input.options?.frequencyPenalty ??
        this.config.options?.frequencyPenalty,
      presence_penalty:
        input.options?.presencePenalty ?? this.config.options?.presencePenalty,
      text: {
        format: zodTextFormat(input.schema, 'object'),
      },
    });

    for await (const chunk of stream) {
      if (chunk.type === 'response.output_text.delta' && chunk.delta) {
        recievedObj += chunk.delta;

        try {
          yield parse(recievedObj) as T;
        } catch (err) {
          console.log('Error parsing partial object from OpenAI:', err);
          yield {} as T;
        }
      } else if (chunk.type === 'response.output_text.done' && chunk.text) {
        try {
          yield parse(chunk.text) as T;
        } catch (err) {
          throw new Error(`Error parsing response from OpenAI: ${err}`);
        }
      }
    }
  }
}

export default OpenAILLM;

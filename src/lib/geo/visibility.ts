import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { GeoObservation, GeoQuestion, GeoSeed, GeoTask } from './types';
import type { WorkflowQuestion } from './workflow-types';
import { frozenQuestion, matchesQuestionTarget } from './search-protocol';
import { evidenceLocation } from './projects';
import type {
  GeoProviderId,
  GeoVisibility,
  GeoVisibilityResult,
  GeoVisibilitySource,
} from './visibility-types';

// Historical measurements are local runtime data, never bundled with the app.
export const visibilityEvidencePaths: string[] = [];

const webSource = z.object({ title: z.string().optional(), url: z.string() });
const rawSearch = z.object({ results: z.array(webSource) });

// Read only saved project evidence. Missing files must not become a positive result.
function readEvidence(file: string): unknown {
  const { root, target: requested } = evidenceLocation(file);
  try {
    const target = fs.realpathSync(requested);
    if (!target.startsWith(fs.realpathSync(root) + path.sep)) return null;
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return null;
  }
}

function normalizedURL(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, '').toLowerCase()}`;
  } catch {
    return null;
  }
}

function isProjectURL(value: string, seed: GeoSeed): boolean {
  const candidate = normalizedURL(value);
  return (
    candidate !== null &&
    [seed.project.siteUrl, seed.project.repositoryUrl].some((root) => {
      const target = normalizedURL(root);
      return (
        target !== null &&
        (candidate === target || candidate.startsWith(`${target}/`))
      );
    })
  );
}

function sourceFor(
  url: string,
  seed: GeoSeed,
  attribution: GeoVisibilitySource['attribution'],
  position: number | null = null,
  title?: string,
): GeoVisibilitySource {
  const asset = seed.assets.find(
    (item) =>
      item.publicUrl && normalizedURL(item.publicUrl) === normalizedURL(url),
  );
  return {
    title:
      asset?.title ||
      title ||
      (normalizedURL(url) === normalizedURL(seed.project.repositoryUrl)
        ? `${seed.project.owner}/${seed.project.name} · GitHub 仓库`
        : url),
    url,
    position,
    attribution,
    ...(asset ? { assetId: asset.id } : {}),
  };
}

function unmeasured(
  providerId: GeoProviderId,
  unavailable = false,
): GeoVisibilityResult {
  return {
    providerId,
    status: 'unmeasured',
    query: null,
    recordedAt: null,
    summary: unavailable
      ? '这份测量记录暂时无法读取'
      : '这个入口还没有测过此问题',
    sources: [],
    evidencePath: null,
    sampleCount: 0,
    caveat: '未测或无法读取不代表没有找到项目。',
  };
}

export function readImportedDeepSeek(_seed: GeoSeed): {
  questions: GeoQuestion[];
  observation: GeoObservation;
} | null {
  return null;
}

function deepSeekResult(
  question: GeoQuestion,
  seed: GeoSeed,
): GeoVisibilityResult {
  const raw = rawSearch.safeParse(readEvidence(question.evidencePath));
  if (!raw.success) return unmeasured('deepseek', true);
  const sources = raw.data.results.flatMap((source, index) =>
    isProjectURL(source.url, seed)
      ? [sourceFor(source.url, seed, 'web_result', index + 1, source.title)]
      : [],
  );
  return {
    providerId: 'deepseek',
    status: sources.length > 0 ? 'found' : 'not_found',
    query: question.query,
    recordedAt: question.measurementAt,
    summary:
      sources.length > 0
        ? `本次网页结果找到 ${sources.length} 个项目来源`
        : `本次返回的 ${raw.data.results.length} 条网页结果中未找到项目`,
    sources,
    evidencePath: question.evidencePath,
    sampleCount: 1,
    searchResultCount: raw.data.results.length,
    caveat:
      'DeepSeek 搜索 API 返回的网页列表，未测 DeepSeek 聊天回答；未返回项目不证明没有收录。',
  };
}

const questionKey = (question: { id: string; query: string }) =>
  JSON.stringify([question.id, question.query]);
type AnswerObservation = {
  question: GeoQuestion;
  target: WorkflowQuestion;
  provider: 'doubao' | 'qwen';
};

function answerObservations(tasks: GeoTask[]): Map<string, AnswerObservation> {
  const observations: AnswerObservation[] = [];
  for (const task of tasks) {
    const workflow = task.workflow;
    const provider = workflow?.collection?.provider;
    if (!workflow || (provider !== 'doubao' && provider !== 'qwen')) continue;
    const runs = [
      ...(workflow.baseline ? [workflow.baseline] : []),
      ...task.runs,
    ];
    for (const run of runs) {
      if (
        run.mode !== 'live' ||
        run.status !== 'completed' ||
        run.protocolKey !== workflow.protocolKey ||
        !run.queryCount ||
        run.queryCount !== workflow.questions.length ||
        run.completedCount !== run.queryCount ||
        run.questions.length !== run.queryCount ||
        new Set(run.questions.map(questionKey)).size !== run.queryCount ||
        !workflow.questions.every((target) =>
          run.questions.some(
            (question) =>
              questionKey(question) === questionKey(target) &&
              question.providerId === provider &&
              question.answer?.searchPerformed &&
              question.answer.text.trim() &&
              Number.isFinite(Date.parse(question.measurementAt)),
          ),
        )
      )
        continue;
      for (const question of run.questions) {
        const target = workflow.questions.find(
          (item) => questionKey(item) === questionKey(question),
        )!;
        observations.push({ question, target, provider });
      }
    }
  }
  observations.sort(
    (a, b) =>
      Date.parse(b.question.measurementAt) -
      Date.parse(a.question.measurementAt),
  );
  const latest = new Map<string, AnswerObservation>();
  for (const observation of observations) {
    const key = `${observation.provider}:${questionKey(observation.question)}`;
    if (!latest.has(key)) latest.set(key, observation);
  }
  return latest;
}

function apiAnswerResult(
  providerId: 'doubao' | 'qwen',
  observation: AnswerObservation | undefined,
  seed: GeoSeed,
): GeoVisibilityResult {
  if (!observation)
    return { ...unmeasured(providerId), metric: 'answer_target_citation' };
  const { question, target } = observation;
  const sources = [
    ...new Map(
      question
        .answer!.citations.filter((citation) =>
          matchesQuestionTarget(citation.url, target, seed),
        )
        .map((citation) => [
          citation.url,
          sourceFor(citation.url, seed, 'citation', null, citation.title),
        ]),
    ).values(),
  ];
  return {
    providerId,
    status: sources.length ? 'found' : 'not_found',
    query: question.query,
    recordedAt: question.measurementAt,
    summary: sources.length
      ? `本次联网回答原生引用了 ${sources.length} 个目标页面`
      : '本次完整联网回答没有原生引用目标页面',
    sources,
    evidencePath: question.evidencePath,
    sampleCount: 1,
    mode: 'API 联网回答',
    metric: 'answer_target_citation',
    caveat: `仅代表该 API 的这次回答，不代表消费者 App。目标为${target.target === 'article' ? '任务指定文章' : '项目网站或仓库'}；只统计回答中的原生引用，搜索参考来源不算引用，引用次序也不是搜索排名。`,
  };
}

export function buildVisibility(
  seed: GeoSeed,
  currentQuestions: GeoQuestion[],
  tasks: GeoTask[] = [],
): GeoVisibility {
  const providers: GeoVisibility['providers'] = [
    { id: 'chatgpt', label: 'ChatGPT', kind: 'answer' },
    { id: 'google', label: 'Google', kind: 'web' },
    { id: 'gemini', label: 'Gemini', kind: 'answer' },
    { id: 'deepseek', label: 'DeepSeek', kind: 'web' },
    { id: 'doubao', label: '豆包 API', kind: 'answer' },
    { id: 'qwen', label: '千问 API', kind: 'answer' },
  ];
  const latestAnswers = answerObservations(tasks);
  const merged = new Map(
    currentQuestions.map((question) => [questionKey(question), question]),
  );
  const currentKeys = new Set(merged.keys());
  for (const task of tasks) {
    if (
      !['doubao', 'qwen'].includes(
        task.workflow?.collection?.provider ?? task.collectionProvider ?? '',
      )
    )
      continue;
    for (const question of task.workflow?.questions ?? []) {
      const key = questionKey(question);
      const existing = merged.get(key);
      merged.set(
        key,
        existing
          ? {
              ...existing,
              matchingAssetIds: [
                ...new Set([
                  ...(existing.matchingAssetIds || []),
                  ...question.assetIds,
                ]),
              ],
            }
          : frozenQuestion(question),
      );
    }
  }
  const questions = [...merged.values()].map((question) => {
    return {
      id: questionKey(question),
      title: question.query,
      kind: ['L1', 'brand'].includes(question.tier)
        ? ('brand' as const)
        : ('scenario' as const),
      relatedAssetIds: question.matchingAssetIds || [],
      results: providers.map((provider) =>
        provider.id === 'doubao' || provider.id === 'qwen'
          ? apiAnswerResult(
              provider.id,
              latestAnswers.get(`${provider.id}:${questionKey(question)}`),
              seed,
            )
          : provider.id === 'deepseek'
            ? currentKeys.has(questionKey(question))
              ? deepSeekResult(question, seed)
              : unmeasured('deepseek')
            : unmeasured(provider.id),
      ),
    };
  });
  const recordedTimes = questions.flatMap((question) =>
    question.results.flatMap((result) =>
      result.recordedAt ? [result.recordedAt] : [],
    ),
  );
  recordedTimes.sort((a, b) => Date.parse(b) - Date.parse(a));
  return {
    providers,
    questions,
    updatedAt: recordedTimes[0] || seed.project.asOf,
  };
}

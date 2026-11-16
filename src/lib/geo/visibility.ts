import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { GeoQuestion, GeoSeed, GeoTask } from './types';
import { evidenceLocation } from './projects';
import { readLocalProjectFile } from './project-data';
import type {
  GeoProviderId,
  GeoVisibility,
  GeoVisibilityResult,
  GeoVisibilitySource,
} from './visibility-types';

const visibilityImport = z.object({
  evidencePaths: z.array(z.string()),
  brand: z.object({
    questionId: z.string(),
    id: z.string(),
    title: z.string(),
    evidencePaths: z.object({ chatgpt: z.string(), google: z.string() }),
  }).optional(),
});

function readVisibilityImport(projectId: string): z.infer<typeof visibilityImport> | null {
  try {
    const records = readLocalProjectFile<Record<string, unknown>>('visibility-imports.json');
    return records[projectId] ? visibilityImport.parse(records[projectId]) : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function visibilityEvidencePaths(projectId: string): string[] {
  return readVisibilityImport(projectId)?.evidencePaths || [];
}

const timestamp = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)));
const answerRecord = z.object({
  recorded_at_utc: timestamp,
  exact_prompt: z.string().min(1),
  status: z.literal('completed'),
  project_identity_mentioned: z.boolean(),
  target_links_in_answer: z.array(z.string()),
  sample_count: z.number().int().positive().optional(),
  sample_count_completed: z.number().int().positive().optional(),
  inline_target_citations_visible: z.boolean().optional(),
  mode_shown: z.string().optional(),
  mode_shown_before_submission: z.string().optional(),
});
const googleRecord = z.object({
  recorded_at_utc: timestamp,
  exact_query: z.string().min(1),
  status: z.literal('completed'),
  target_url_returned: z.boolean(),
  target_url: z.string(),
  sample_count: z.number().int().positive(),
  observed_standard_web_result_position: z.number().int().positive(),
});

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

function answerResult(
  providerId: 'chatgpt',
  seed: GeoSeed,
  evidencePath: string,
): GeoVisibilityResult {
  const parsed = answerRecord.safeParse(readEvidence(evidencePath));
  if (!parsed.success) return unmeasured(providerId, true);
  const record = parsed.data;
  const sampleCount = record.sample_count_completed || record.sample_count;
  if (!sampleCount) return unmeasured(providerId, true);
  const attribution =
    record.inline_target_citations_visible ? 'citation' : 'link';
  const sources = [...new Set(record.target_links_in_answer)]
    .filter((url) => isProjectURL(url, seed))
    .map((url) => sourceFor(url, seed, attribution));
  const found = record.project_identity_mentioned && sources.length > 0;
  return {
    providerId,
    status: found ? 'found' : 'not_found',
    query: record.exact_prompt,
    recordedAt: record.recorded_at_utc,
    summary: found
      ? attribution === 'citation'
        ? `正确识别项目，回答中引用了 ${sources.length} 个项目来源`
        : `正确识别项目，回答中列出 ${sources.length} 个项目链接`
      : '本次回答中未确认找到项目及其来源',
    sources,
    evidencePath,
    sampleCount,
    mode: record.mode_shown_before_submission || record.mode_shown,
    caveat:
      '临时对话中的一次品牌提问；记录可见引用，未取得检索排名。不能据此推断不带项目名时也能发现项目。',
  };
}

function googleResult(seed: GeoSeed, evidencePath: string): GeoVisibilityResult {
  const parsed = googleRecord.safeParse(readEvidence(evidencePath));
  if (!parsed.success) return unmeasured('google', true);
  const record = parsed.data;
  const found =
    record.target_url_returned && isProjectURL(record.target_url, seed);
  return {
    providerId: 'google',
    status: found ? 'found' : 'not_found',
    query: record.exact_query,
    recordedAt: record.recorded_at_utc,
    summary: found
      ? `GitHub 仓库出现在本次普通网页结果第 ${record.observed_standard_web_result_position} 位`
      : '本次普通网页结果中未找到项目',
    sources: found
      ? [
          sourceFor(
            record.target_url,
            seed,
            'web_result',
            record.observed_standard_web_result_position,
          ),
        ]
      : [],
    evidencePath,
    sampleCount: record.sample_count,
    caveat:
      '仅代表这次浏览器会话的网页结果；账号、地区和时间可能影响排序，Google AI Overview 未测。',
  };
}

const questionKey = (question: { id: string; query: string }) =>
  JSON.stringify([question.id, question.query]);

export function buildVisibility(
  seed: GeoSeed,
  currentQuestions: GeoQuestion[],
  _tasks: GeoTask[] = [],
): GeoVisibility {
  const providers: GeoVisibility['providers'] = [
    { id: 'chatgpt', label: 'ChatGPT', kind: 'answer' },
    { id: 'google', label: 'Google', kind: 'web' },
  ];
  const merged = new Map(
    currentQuestions.map((question) => [questionKey(question), question]),
  );
  const brand = readVisibilityImport(seed.project.id)?.brand;
  const mainBrand = brand ? seed.questions.find((question) => question.id === brand.questionId) : undefined;
  const questions = [...merged.values()].map((question) => {
    const isMainBrand =
      mainBrand !== undefined &&
      questionKey(question) === questionKey(mainBrand);
    return {
      id: isMainBrand && brand ? brand.id : questionKey(question),
      title: isMainBrand && brand
        ? brand.title
        : question.query,
      kind: ['L1', 'brand'].includes(question.tier)
        ? ('brand' as const)
        : ('scenario' as const),
      relatedAssetIds: question.matchingAssetIds || [],
      results: providers.map((provider) =>
        !isMainBrand || !brand
          ? unmeasured(provider.id)
          : provider.id === 'google'
            ? googleResult(seed, brand.evidencePaths.google)
            : answerResult(provider.id, seed, brand.evidencePaths.chatgpt),
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

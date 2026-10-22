import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { GeoObservation, GeoQuestion, GeoSeed } from './types';
import type {
  GeoProviderId,
  GeoVisibility,
  GeoVisibilityResult,
  GeoVisibilitySource,
} from './visibility-types';

const multiSurfaceDirectory = 'sprint-01/evidence/multi-surface-2026-10-20';
const deepSeekDirectory = 'sprint-01/evidence/deepseek-search-2026-10-20';
const summaryPath = `${deepSeekDirectory}/summary.json`;

export const visibilityEvidencePaths = [
  `${multiSurfaceDirectory}/summary.json`,
  `${multiSurfaceDirectory}/chatgpt-brand.json`,
  `${multiSurfaceDirectory}/google-brand.json`,
  `${multiSurfaceDirectory}/gemini-brand.json`,
  `${multiSurfaceDirectory}/query-audit.json`,
  summaryPath,
  `${deepSeekDirectory}/run-metadata.json`,
];

const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)));
const webSource = z.object({ title: z.string().optional(), url: z.string() });
const rawSearch = z.object({ results: z.array(webSource) });
const deepSeekSummary = z.object({
  measured_at_utc_first: timestamp,
  observations: z.array(z.object({
    query_id: z.string(),
    query: z.string(),
    http_status: z.literal(200),
    result_count: z.number().int().nonnegative(),
    project_hit: z.boolean(),
    top3: z.array(webSource),
    evidence_file: z.string(),
    measured_at_utc: timestamp,
  })),
});
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
  const root = path.resolve(
    /^data\/geo-evidence\//.test(file)
      ? process.env.DATA_DIR || process.cwd()
      : process.env.GEO_WORKSPACE || path.join(process.cwd(), '..'),
  );
  try {
    const target = fs.realpathSync(path.resolve(root, file));
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
  return candidate !== null && [seed.project.siteUrl, seed.project.repositoryUrl].some(root => {
    const target = normalizedURL(root);
    return target !== null && (candidate === target || candidate.startsWith(`${target}/`));
  });
}

function sourceFor(
  url: string,
  seed: GeoSeed,
  attribution: GeoVisibilitySource['attribution'],
  position: number | null = null,
  title?: string,
): GeoVisibilitySource {
  const asset = seed.assets.find(item => item.publicUrl && normalizedURL(item.publicUrl) === normalizedURL(url));
  return {
    title: asset?.title || title || (
      normalizedURL(url) === normalizedURL(seed.project.repositoryUrl)
        ? `${seed.project.owner}/${seed.project.name} · GitHub 仓库`
        : url
    ),
    url,
    position,
    attribution,
    ...(asset ? { assetId: asset.id } : {}),
  };
}

function unmeasured(providerId: GeoProviderId, unavailable = false): GeoVisibilityResult {
  return {
    providerId,
    status: 'unmeasured',
    query: null,
    recordedAt: null,
    summary: unavailable ? '这份测量记录暂时无法读取' : '这个入口还没有测过此问题',
    sources: [],
    evidencePath: null,
    sampleCount: 0,
    caveat: '未测或无法读取不代表没有找到项目。',
  };
}

export function readImportedDeepSeek(seed: GeoSeed): {
  questions: GeoQuestion[];
  observation: GeoObservation;
} | null {
  const parsed = deepSeekSummary.safeParse(readEvidence(summaryPath));
  if (!parsed.success || parsed.data.observations.length !== seed.questions.length) return null;
  const observations = parsed.data.observations;
  if (new Set(observations.map(item => item.query_id)).size !== seed.questions.length) return null;
  if (!seed.questions.every(question => observations.some(item => item.query_id === question.id && item.query === question.query))) return null;

  const questions = seed.questions.map(question => {
    const record = observations.find(item => item.query_id === question.id)!;
    const expectedPath = `${deepSeekDirectory}/raw/${question.id}.json`;
    if (record.evidence_file !== expectedPath) return null;
    const raw = rawSearch.safeParse(readEvidence(expectedPath));
    const firstHit = raw.success ? raw.data.results.findIndex(result => isProjectURL(result.url, seed)) : -1;
    return {
      ...question,
      measurementAt: record.measured_at_utc,
      provider: 'DeepSeek Search API',
      resultCount: record.result_count,
      projectHit: record.project_hit,
      rank: firstHit >= 0 ? firstHit + 1 : null,
      aiCited: null,
      topSources: record.top3.map((source, index) => {
        let domain = '';
        try { domain = new URL(source.url).hostname; } catch { /* Invalid source remains visible in local evidence only. */ }
        return {
          position: index + 1,
          title: source.title || domain || '未提供标题',
          url: source.url,
          domain,
          isHomonym: /2609\.38260/i.test(`${source.url} ${source.title || ''}`),
        };
      }),
      evidencePath: expectedPath,
    } satisfies GeoQuestion;
  });
  if (questions.some(question => question === null)) return null;
  const complete = questions as GeoQuestion[];
  return {
    questions: complete,
    observation: {
      id: 'deepseek-2026-10-20',
      measurementAt: parsed.data.measured_at_utc_first,
      provider: 'DeepSeek Search API',
      comparableGroup: 'deepseek-search-v1-count50-fixed14',
      queryCount: complete.length,
      hitCount: complete.filter(question => question.projectHit).length,
      resultCount: complete.reduce((sum, question) => sum + question.resultCount, 0),
      rank: null,
      aiCited: null,
      sourcePath: summaryPath,
      comparabilityNote: '同一 DeepSeek 搜索入口、固定 14 题、count=50、need_content=false，每题一次。执行条件以 run-metadata.json 为准；返回结果未命中不证明没有收录，亦未测 DeepSeek 聊天回答。',
    },
  };
}

function answerResult(providerId: 'chatgpt' | 'gemini', seed: GeoSeed): GeoVisibilityResult {
  const evidencePath = `${multiSurfaceDirectory}/${providerId}-brand.json`;
  const parsed = answerRecord.safeParse(readEvidence(evidencePath));
  if (!parsed.success) return unmeasured(providerId, true);
  const record = parsed.data;
  const sampleCount = record.sample_count_completed || record.sample_count;
  if (!sampleCount) return unmeasured(providerId, true);
  const attribution = providerId === 'chatgpt' && record.inline_target_citations_visible ? 'citation' : 'link';
  const sources = [...new Set(record.target_links_in_answer)]
    .filter(url => isProjectURL(url, seed))
    .map(url => sourceFor(url, seed, attribution));
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
    caveat: providerId === 'chatgpt'
      ? '临时对话中的一次品牌提问；记录可见引用，未取得检索排名。不能据此推断不带项目名时也能发现项目。'
      : '临时对话中的一次品牌提问；记录回答内的链接，未验证后台引用轨迹或检索排名。',
  };
}

function googleResult(seed: GeoSeed): GeoVisibilityResult {
  const evidencePath = `${multiSurfaceDirectory}/google-brand.json`;
  const parsed = googleRecord.safeParse(readEvidence(evidencePath));
  if (!parsed.success) return unmeasured('google', true);
  const record = parsed.data;
  const found = record.target_url_returned && isProjectURL(record.target_url, seed);
  return {
    providerId: 'google',
    status: found ? 'found' : 'not_found',
    query: record.exact_query,
    recordedAt: record.recorded_at_utc,
    summary: found ? `GitHub 仓库出现在本次普通网页结果第 ${record.observed_standard_web_result_position} 位` : '本次普通网页结果中未找到项目',
    sources: found ? [sourceFor(record.target_url, seed, 'web_result', record.observed_standard_web_result_position)] : [],
    evidencePath,
    sampleCount: record.sample_count,
    caveat: '仅代表这次浏览器会话的网页结果；账号、地区和时间可能影响排序，Google AI Overview 未测。',
  };
}

function deepSeekResult(question: GeoQuestion, seed: GeoSeed): GeoVisibilityResult {
  const raw = rawSearch.safeParse(readEvidence(question.evidencePath));
  if (!raw.success) return unmeasured('deepseek', true);
  const sources = raw.data.results.flatMap((source, index) => isProjectURL(source.url, seed)
    ? [sourceFor(source.url, seed, 'web_result', index + 1, source.title)]
    : [],
  );
  return {
    providerId: 'deepseek',
    status: sources.length > 0 ? 'found' : 'not_found',
    query: question.query,
    recordedAt: question.measurementAt,
    summary: sources.length > 0
      ? `本次网页结果找到 ${sources.length} 个项目来源`
      : `本次返回的 ${raw.data.results.length} 条网页结果中未找到项目`,
    sources,
    evidencePath: question.evidencePath,
    sampleCount: 1,
    searchResultCount: raw.data.results.length,
    caveat: 'DeepSeek 搜索 API 返回的网页列表，未测 DeepSeek 聊天回答；未返回项目不证明没有收录。',
  };
}

export function buildVisibility(seed: GeoSeed, currentQuestions: GeoQuestion[]): GeoVisibility {
  const providers: GeoVisibility['providers'] = [
    { id: 'chatgpt', label: 'ChatGPT', kind: 'answer' },
    { id: 'google', label: 'Google', kind: 'web' },
    { id: 'gemini', label: 'Gemini', kind: 'answer' },
    { id: 'deepseek', label: 'DeepSeek', kind: 'web' },
  ];
  const questions = currentQuestions.map(question => {
    const isMainBrand = question.id === 'l1-01';
    return {
      id: isMainBrand ? 'brand-contextadapt' : question.id,
      title: isMainBrand ? 'ContextAdapt 是什么？能找到这个项目吗？' : question.query,
      kind: question.tier === 'L1' ? 'brand' as const : 'scenario' as const,
      relatedAssetIds: question.matchingAssetIds || [],
      results: providers.map(provider => provider.id === 'deepseek'
        ? deepSeekResult(question, seed)
        : !isMainBrand
          ? unmeasured(provider.id)
          : provider.id === 'google'
            ? googleResult(seed)
            : answerResult(provider.id, seed),
      ),
    };
  });
  const recordedTimes = questions.flatMap(question => question.results.flatMap(result => result.recordedAt ? [result.recordedAt] : []));
  recordedTimes.sort((a, b) => Date.parse(b) - Date.parse(a));
  return { providers, questions, updatedAt: recordedTimes[0] || seed.project.asOf };
}

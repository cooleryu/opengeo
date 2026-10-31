import fs from 'node:fs';
import path from 'node:path';
import {
  evidenceLocation,
} from './projects';
import { getSeed } from './seed';
import { getLatestResearch, getResearchBatch } from './research';
import { attachOverviewData } from './overview-data';
import { attachCompetitorPerformance } from './competitor-performance';
import { getCompetitorSelection, persistCompetitorTarget, readStoredTarget } from './competitor-store';
export { getCompetitorSelection } from './competitor-store';
import type { GeoProject } from './types';
import type { ResearchBatch, ResearchObservation } from './research-types';
import { parseQwenAnswer } from './providers/qwen';
import { parseDoubaoAnswer } from './providers/doubao';
import type {
  CompetitorComparison,
  CompetitorMatch,
  CompetitorTarget,
} from './competitor-types';

export class CompetitorError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function text(value: unknown, label: string, max = 120): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new CompetitorError(`${label}不能为空，且不超过 ${max} 字。`);
  return value.trim();
}

function publicUrl(value: unknown): string {
  const input = text(value, '官方入口', 2048);
  try {
    const url = new URL(input);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      /\s/u.test(input)
    )
      throw new Error();
    url.hash = '';
    url.search = '';
    return url.toString();
  } catch {
    throw new CompetitorError(
      '官方入口须为不含账号密码的 http 或 https 链接。',
    );
  }
}

export function normalizeCompetitorTarget(
  input: unknown,
): CompetitorTarget | null {
  if (input === null) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new CompetitorError('对标对象格式无效。');
  const value = input as Record<string, unknown>;
  const name = text(value.name, '名称');
  if (!Array.isArray(value.aliases) || value.aliases.length > 12)
    throw new CompetitorError('别名最多 12 个。');
  if (
    !Array.isArray(value.officialUrls) ||
    value.officialUrls.length < 1 ||
    value.officialUrls.length > 6
  )
    throw new CompetitorError('请填写 1—6 个官方入口。');
  return {
    name,
    aliases: [
      ...new Set(
        value.aliases
          .map((alias) => text(alias, '别名'))
          .filter(
            (alias) => alias.toLocaleLowerCase() !== name.toLocaleLowerCase(),
          ),
      ),
    ],
    officialUrls: [...new Set(value.officialUrls.map(publicUrl))],
    updatedAt: new Date().toISOString(),
  };
}

export function readCompetitorTarget(): CompetitorTarget | null {
  return readStoredTarget();
}

export function saveCompetitorTarget(input: unknown, batchId?: string): CompetitorTarget | null {
  const target = normalizeCompetitorTarget(input);
  const project = getSeed().project;
  const batch = batchId === undefined ? getLatestResearch(project.id) : getResearchBatch(project.id, batchId);
  if (batchId !== undefined && !batch) throw new CompetitorError('没有找到当前项目的研究批次。', 404);
  persistCompetitorTarget(target, buildCompetitorComparison(project, attachOverviewData(batch), target));
  return readStoredTarget();
}

/** Match only the configured host and exact path or its children, never another repository on the same host. */
export function matchesOfficialUrl(source: string, official: string): boolean {
  try {
    const left = new URL(source);
    const right = new URL(official);
    // GitHub repository identities are case-insensitive; file paths inside
    // repositories and paths on other hosts keep their original boundaries.
    if (
      left.hostname.toLowerCase() === 'github.com' &&
      right.hostname.toLowerCase() === 'github.com'
    ) {
      const repositoryPath = (value: string) =>
        value
          .split('/')
          .map((part, index) => (index <= 2 ? part.toLowerCase() : part))
          .join('/');
      left.pathname = repositoryPath(left.pathname);
      right.pathname = repositoryPath(right.pathname);
    }
    if (
      !['http:', 'https:'].includes(left.protocol) ||
      left.hostname.toLowerCase().replace(/^www\./, '') !==
        right.hostname.toLowerCase().replace(/^www\./, '') ||
      left.port !== right.port
    )
      return false;
    const base = right.pathname.replace(/\/+$/, '');
    return (
      !base || left.pathname === base || left.pathname.startsWith(`${base}/`)
    );
  } catch {
    return false;
  }
}

function answerBody(value: string): string | null {
  const lines: string[] = [];
  let sourceDepth: number | null = null;
  for (const line of value.split(/\r?\n/)) {
    const heading = /^(#{1,6})[ \t]+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const depth = heading[1].length;
      if (sourceDepth !== null && depth <= sourceDepth) sourceDepth = null;
      if (
        /^(?:(?:主要)?引用来源|参考来源|参考资料|参考文献|(?:(?:inline|body|visible)\s+)?(?:sources|citations)|references)\s*[:：]?$/iu.test(
          heading[2],
        )
      )
        sourceDepth = depth;
    }
    if (sourceDepth !== null || /^Capture(?: note)?:/i.test(line)) continue;
    lines.push(line);
  }
  return lines.join('\n').trim() || null;
}

/** Registered answer sections exclude the query, source appendices, and capture metadata. */
export function extractCompetitorAnswer(raw: string | null): string | null {
  if (!raw) return null;
  if (/^\s*[\[{]/.test(raw)) {
    try {
      const parsed = JSON.parse(raw);
      const direct =
        parsed.answer_text ??
        parsed.answerText ??
        parsed.rendered_answer ??
        parsed.renderedAnswer;
      if (typeof direct === 'string') return answerBody(direct);
      if (parsed.output?.choices)
        return answerBody(parseQwenAnswer(parsed).text);
      if (Array.isArray(parsed.output))
        return answerBody(parseDoubaoAnswer(parsed).text);
      return null;
    } catch {
      return null;
    }
  }
  const section =
    /^##\s+(?:Answer text|Rendered answer|平台回答转录)\s*\r?\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/im.exec(
      raw,
    );
  return section?.[1] ? answerBody(section[1]) : null;
}

export function matchCompetitorNames(
  answer: string | null,
  names: string[],
): CompetitorMatch {
  if (answer === null) return { status: 'unknown', names: [], excerpts: [] };
  // A visible linked name is prose; link targets, titles, and definitions are not.
  const prose = answer
    .replace(/^\s{0,3}\[[^\]\n]+\]:[^\n]*$/gm, '')
    .replace(
      /(!?)\[([^\]\n]*)\]\((?:\\.|[^\\\n)])*\)/g,
      (_match, image, label) => (image ? '' : label),
    )
    .replace(/<https?:\/\/[^>]*>/giu, '')
    .replace(/https?:\/\/[^\s<>"']+/giu, '');
  const matched: string[] = [];
  const excerpts: string[] = [];
  for (const name of [...new Set(names)]) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const start = /^[a-z0-9]/i.test(name) ? '(?<![a-z0-9_])' : '';
    const end = /[a-z0-9]$/i.test(name) ? '(?![a-z0-9_])' : '';
    const result = new RegExp(`${start}${escaped}${end}`, 'iu').exec(prose);
    if (!result) continue;
    matched.push(name);
    const from = Math.max(0, result.index - 90);
    const to = Math.min(prose.length, result.index + result[0].length + 130);
    excerpts.push(
      `${from ? '…' : ''}${prose.slice(from, to).replace(/\s+/g, ' ')}${to < prose.length ? '…' : ''}`,
    );
  }
  return {
    status: matched.length ? 'matched' : 'not_seen',
    names: matched,
    excerpts,
  };
}

export function matchCompetitorIdentity(
  answer: string | null,
  names: string[],
  officialUrls: string[],
): CompetitorMatch {
  const match = matchCompetitorNames(answer, names);
  if (!answer || match.status !== 'matched') return match;
  let conflictingRepository = false;
  let identified = false;
  for (const link of answer.matchAll(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)(?:\s+[^)]*)?\)/g,
  )) {
    if (matchCompetitorNames(link[1], names).status !== 'matched') continue;
    if (officialUrls.some((official) => matchesOfficialUrl(link[2], official)))
      identified = true;
    else {
      try {
        const url = new URL(link[2]);
        if (
          url.hostname.toLowerCase() === 'github.com' &&
          url.pathname.split('/').filter(Boolean).length >= 2
        )
          conflictingRepository = true;
      } catch {
        /* An invalid destination cannot establish identity. */
      }
    }
  }
  return conflictingRepository && !identified
    ? { status: 'unknown', names: [], excerpts: match.excerpts }
    : match;
}

export function readCompetitorEvidence(file: string): string | null {
  const { root, target } = evidenceLocation(file);
  try {
    const real = fs.realpathSync(target);
    if (
      !real.startsWith(fs.realpathSync(root) + path.sep) ||
      !fs.statSync(real).isFile() ||
      fs.statSync(real).size > 4 * 1024 * 1024
    )
      return null;
    return fs.readFileSync(real, 'utf8');
  } catch {
    return null;
  }
}

export function readCompetitorObservationAnswer(
  observation: ResearchObservation,
  read: (file: string) => string | null = readCompetitorEvidence,
): string | null {
  if (
    observation.entryType === 'api_search' ||
    observation.entryType === 'web_search' ||
    observation.engine === 'google'
  )
    return null;
  const file =
    observation.answerPath ||
    (observation.entryType === 'api_answer' ? observation.evidencePath : '');
  if (!file) return null;
  const raw = read(file);
  if (raw === null) return null;
  // These files are the persisted normalized provider answer, not a report or query.
  if (observation.entryType === 'api_answer' && file.endsWith('.answer.md'))
    return answerBody(raw);
  return extractCompetitorAnswer(raw);
}

export function buildCompetitorComparison(
  project: GeoProject,
  batch: ResearchBatch | null,
  target: CompetitorTarget | null,
  read: (file: string) => string | null = readCompetitorEvidence,
): CompetitorComparison {
  const officialUrls = [
    ...new Set([project.siteUrl, project.repositoryUrl].filter(Boolean)),
  ];
  let repositoryName = '';
  try {
    repositoryName =
      new URL(project.repositoryUrl).pathname
        .split('/')
        .filter(Boolean)
        .at(-1) || '';
  } catch {
    /* No repository alias when no valid project repository exists. */
  }
  const own = {
    name: project.name,
    aliases: [
      ...new Set(
        [repositoryName].filter((name) => name && name !== project.name),
      ),
    ],
    officialUrls,
  };
  const validBatch = batch?.projectId === project.id ? batch : null;
  return {
    projectId: project.id,
    own,
    target,
    batch: validBatch ? { id: validBatch.id, date: validBatch.date } : null,
    rows:
      target && validBatch
        ? validBatch.questions.flatMap((question) =>
            question.observations.flatMap((observation, observationIndex) => {
              // Imported Google headings have an observed organic position;
              // unpositioned links include AI Overview and other page content.
              const sources =
                observation.engine === 'google'
                  ? observation.sources.filter(
                      (source) =>
                        Number.isInteger(source.position) &&
                        (source.position ?? 0) > 0,
                    )
                  : observation.sources;
              const answer = readCompetitorObservationAnswer(observation, read);
              const ownNameMatch = matchCompetitorIdentity(
                answer,
                [own.name, ...own.aliases],
                own.officialUrls,
              );
              const audits = validBatch.answerAudits?.filter(
                (audit) =>
                  audit.projectId === project.id &&
                  audit.batchId === validBatch.id &&
                  audit.questionId === question.id &&
                  audit.engine === observation.engine &&
                  audit.language === observation.language &&
                  audit.recordedAt === observation.recordedAt &&
                  audit.evidencePath ===
                    (observation.answerPath ?? observation.evidencePath),
              );
              const audit = audits?.length === 1 ? audits[0] : undefined;
              // Persisted identity review takes precedence over a raw same-name
              // occurrence (including the unrelated 项目 paper).
              const ownMention: CompetitorMatch =
                audits === undefined
                  ? ownNameMatch
                  : {
                      status:
                        !audit?.answerComplete || audit.mention === 'unknown'
                          ? 'unknown'
                          : audit.mention === 'yes'
                            ? 'matched'
                            : 'not_seen',
                      names:
                        audit?.answerComplete && audit.mention === 'yes'
                          ? [own.name]
                          : [],
                      excerpts: audit?.mentionEvidence
                        ? [audit.mentionEvidence]
                        : [],
                    };
              return [
                {
                  id: `${question.id}:${observationIndex}`,
                  questionId: question.id,
                  question: question[observation.language],
                  query: observation.query,
                  observationIndex,
                  engine: observation.engine,
                  entryType: observation.entryType,
                  language: observation.language,
                  recordedAt: observation.recordedAt,
                  collectedAt: observation.collectedAt,
                  conditions: observation.conditions,
                  evidencePath: observation.evidencePath,
                  answerPath: observation.answerPath,
                  answerAvailable: answer !== null,
                  sourcesAvailable: sources.length > 0,
                  ownMention,
                  targetMention:
                    audits !== undefined && !audit?.answerComplete
                      ? { status: 'unknown', names: [], excerpts: [] }
                      : matchCompetitorIdentity(
                          answer,
                          [target.name, ...target.aliases],
                          target.officialUrls,
                        ),
                  sources: sources.map((source) => ({
                    ...source,
                    own: officialUrls.some((url) =>
                      matchesOfficialUrl(source.url, url),
                    ),
                    target: target.officialUrls.some((url) =>
                      matchesOfficialUrl(source.url, url),
                    ),
                  })),
                },
              ];
            }),
          )
        : [],
  };
}

export function getCompetitorComparison(
  batchId?: string,
): CompetitorComparison {
  const project = getSeed().project;
  if (
    batchId !== undefined &&
    (typeof batchId !== 'string' || !batchId.trim() || batchId.length > 200)
  )
    throw new CompetitorError('研究批次编号无效。');
  const batch =
    batchId === undefined
      ? getLatestResearch(project.id)
      : getResearchBatch(project.id, batchId);
  if (batchId !== undefined && !batch)
    throw new CompetitorError('没有找到当前项目的研究批次。', 404);
  const reviewedBatch = attachOverviewData(batch);
  return { ...attachCompetitorPerformance(reviewedBatch, buildCompetitorComparison(
    project,
    reviewedBatch,
    readCompetitorTarget(),
  )), selection: getCompetitorSelection() };
}

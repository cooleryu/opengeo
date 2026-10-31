import type { CompetitorComparison, CompetitorPerformanceData, CompetitorTarget } from './competitor-types';
import {
  matchCompetitorIdentity, matchCompetitorNames, matchesOfficialUrl,
  readCompetitorEvidence, readCompetitorObservationAnswer,
} from './competitors';
import {
  auditRows, isAiAnswerRow, summarizeMetric, summarizeMetricVerdicts,
  type AuditedResearchRow, type MetricSummary,
} from './overview-metrics';
import { RESEARCH_ENGINES } from './research-engines';
import type { ResearchBatch } from './research-types';
import { getResearchMetrics, getResearchRows, observationTime, type ResearchRow } from './research-view';
import { parseQwenAnswer } from './providers/qwen';
import { parseDoubaoAnswer } from './providers/doubao';
import {
  competitorCitationIdentityKey, competitorCitationMatchesObservation, readCompetitorCitationAuditData,
  type CompetitorCitationAuditRecord,
} from './competitor-citation-store';

type ReadEvidence = (file: string) => string | null;
type Verdict = 'yes' | 'no' | 'unknown';
type JsonRecord = Record<string, unknown>;

function object(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord : undefined;
}

function capture(raw: string | null): JsonRecord | undefined {
  if (!raw) return undefined;
  try { return object(JSON.parse(raw)); } catch { return undefined; }
}

function incomplete(raw: string | null, field: 'answerComplete' | 'sourcesComplete'): boolean {
  const data = capture(raw);
  return data?.complete === false || data?.captureComplete === false || data?.partial === true ||
    data?.truncated === true || object(data?.capture)?.complete === false ||
    data?.[field] === false || object(data?.evidence)?.[field] === false ||
    /^Capture(?: note)?:[^\n]*(?:partial|incomplete|truncat)/im.test(raw ?? '');
}

function completeAnswer(row: AuditedResearchRow, raw: string | null): boolean {
  if (incomplete(raw, 'answerComplete')) return false;
  // auditRows has already required exact project/batch/time/path identity.
  if (row.audit?.answerComplete) return true;
  const data = capture(raw);
  if (object(data?.evidence)?.answerComplete === true) return true;
  if (row.observation?.entryType !== 'api_answer' || !data) return false;
  try {
    const answer = row.engine === 'qwen' ? parseQwenAnswer(data)
      : row.engine === 'doubao' ? parseDoubaoAnswer(data) : undefined;
    return answer?.evidence?.answerComplete === true;
  } catch { return false; }
}

function targetMention(row: AuditedResearchRow, target: CompetitorTarget, read: ReadEvidence): Verdict {
  const observation = row.observation!;
  const answer = readCompetitorObservationAnswer(observation, read);
  if (answer === null || !completeAnswer(row, read(observation.evidencePath)) ||
      incomplete(read(observation.answerPath ?? observation.evidencePath), 'answerComplete')) return 'unknown';
  const names = [target.name, ...target.aliases];
  const match = matchCompetitorIdentity(answer, names, target.officialUrls);
  if (match.status === 'not_seen') return 'no';
  if (match.status !== 'matched') return 'unknown';
  // A same-name occurrence alone cannot establish which product was mentioned.
  const linkedIdentity = [...answer.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)(?:\s+[^)]*)?\)/g)]
    .some((link) => matchCompetitorNames(link[1], names).status === 'matched' &&
      target.officialUrls.some((url) => matchesOfficialUrl(link[2], url)));
  const sourcedIdentity = observation.sources.some((source) =>
    target.officialUrls.some((url) => matchesOfficialUrl(source.url, url)));
  return linkedIdentity || sourcedIdentity ? 'yes' : 'unknown';
}

function targetSource(row: ResearchRow, target: CompetitorTarget, read: ReadEvidence): Verdict {
  const observation = row.observation!;
  const raw = read(observation.evidencePath);
  if (incomplete(raw, 'sourcesComplete')) return 'unknown';
  // Google imports also contain AI Overview links; only ranked organic results
  // belong to the overview's Google search metric.
  const sources = observation.engine === 'google'
    ? observation.sources.filter((source) => Number.isInteger(source.position) && source.position! > 0)
    : observation.sources;
  if (sources.some((source) => target.officialUrls.some((url) => matchesOfficialUrl(source.url, url)))) return 'yes';
  const data = capture(raw);
  if (data?.sourcesComplete === true || object(data?.evidence)?.sourcesComplete === true) return 'no';
  // A persisted DeepSeek response contains the whole returned result array.
  // Verify that the observation retained that array before declaring absence.
  if (observation.engine === 'deepseek' && Array.isArray(data?.results)) {
    const urls = data.results.map((item: unknown) => object(item)?.url);
    if (urls.every((url) => typeof url === 'string') && urls.length === sources.length &&
        urls.every((url, index) => url === sources[index].url)) return 'no';
  }
  return 'unknown';
}

function ownSources(rows: ResearchRow[]): MetricSummary {
  const result = getResearchMetrics(rows);
  return {
    rate: result.rate, minimumRate: result.rate,
    yes: result.found, no: result.completed - result.found, unknown: 0,
    completed: result.completed, unmeasured: result.unmeasured, questions: result.totalQuestions,
  };
}

function targetCitation(
  row: ResearchRow, batch: ResearchBatch, target: CompetitorTarget, audits: CompetitorCitationAuditRecord[],
): { verdict: Verdict; limitations: string[] } {
  if (!row.observation) return { verdict: 'unknown', limitations: [] };
  const identity = competitorCitationIdentityKey(target);
  const record = audits.find((audit) => audit.identityKey === identity &&
    competitorCitationMatchesObservation(audit, batch, row.question.id, row.observation!));
  return record ? { verdict: record.citation, limitations: record.citation === 'unknown' ? record.limitations : [] }
    : { verdict: 'unknown', limitations: ['该竞品尚无与当前观测及官方入口匹配的已保存引用审核。'] };
}

/** Keep current detail rows and headline verdicts consistent without rewriting
 * stored selections, historical captures, or the original comparison object.
 */
export function attachCompetitorPerformance(
  batch: ResearchBatch | null,
  comparison: CompetitorComparison,
  read: ReadEvidence = readCompetitorEvidence,
  citationAudits?: CompetitorCitationAuditRecord[],
): CompetitorComparison {
  const valid = batch && comparison.target && batch.projectId === comparison.projectId && batch.id === comparison.batch?.id;
  const byObservation = new Map<string, AuditedResearchRow>();
  if (valid) {
    for (const language of ['zh', 'en'] as const) {
      const rows = auditRows(batch, getResearchRows(batch, {
        language, engine: 'all', kind: 'all', result: 'all',
      }, { includeHistory: true }), batch.answerAudits ?? []);
      for (const row of rows) {
        if (row.observation) byObservation.set(`${row.question.id}:${row.question.observations.indexOf(row.observation)}`, row);
      }
    }
  }
  const rows = comparison.rows.map((row) => {
    const sample = byObservation.get(`${row.questionId}:${row.observationIndex}`);
    const observation = sample?.observation;
    const sameObservation = observation && row.engine === observation.engine && row.language === observation.language &&
      row.recordedAt === observation.recordedAt && row.evidencePath === observation.evidencePath &&
      (row.answerPath ?? row.evidencePath) === (observation.answerPath ?? observation.evidencePath);
    const verdict = sameObservation && isAiAnswerRow(sample!) && comparison.target
      ? targetMention(sample!, comparison.target, read) : 'unknown';
    return { ...row, targetMention: {
      ...row.targetMention,
      status: verdict === 'yes' ? 'matched' as const : verdict === 'no' ? 'not_seen' as const : 'unknown' as const,
    } };
  });
  return { ...comparison, rows, performance: buildCompetitorPerformance(batch, comparison, read, citationAudits) };
}

/** Read-only projection of the exact latest samples used by ProjectOverview. */
export function buildCompetitorPerformance(
  batch: ResearchBatch | null,
  comparison: CompetitorComparison,
  readEvidence: ReadEvidence = readCompetitorEvidence,
  citationAudits?: CompetitorCitationAuditRecord[],
): CompetitorPerformanceData {
  const result: CompetitorPerformanceData = {
    ownName: comparison.own.name, targetName: comparison.target?.name ?? '', scopes: {},
  };
  if (!batch || !comparison.target || batch.projectId !== comparison.projectId || batch.id !== comparison.batch?.id) return result;
  const target = comparison.target;
  const audits = citationAudits ?? readCompetitorCitationAuditData(batch.projectId, batch.id).records;
  const cache = new Map<string, string | null>();
  const read: ReadEvidence = (file) => {
    if (!cache.has(file)) cache.set(file, readEvidence(file));
    return cache.get(file)!;
  };
  const engines = RESEARCH_ENGINES.filter((engine) => batch.questions.some((question) =>
    question.observations.some((observation) => observation.engine === engine)));
  for (const language of ['zh', 'en'] as const) {
    for (const engine of ['all', ...engines] as const) {
      const rows = auditRows(batch, getResearchRows(batch, { language, engine, kind: 'all', result: 'all' }), batch.answerAudits ?? []);
      const platforms = (engine === 'all' ? engines : [engine]).map((platform) => {
        const samples = rows.filter((row) => row.engine === platform);
        const measured = samples.filter((row) => row.observation);
        return { platform, rows: samples, ai: (measured.length ? measured : samples).some(isAiAnswerRow) };
      });
      const metrics: CompetitorPerformanceData['scopes'][string]['metrics'] = [];
      if (platforms.some((platform) => platform.ai)) {
        const aiRows = rows.filter(isAiAnswerRow);
        for (const metric of ['mention', 'citation'] as const) {
          const targetLimitations = metric === 'citation' ? [...new Set(aiRows.flatMap((row) =>
            targetCitation(row, batch, target, audits).limitations))] : [];
          metrics.push({
            id: metric, label: metric === 'mention' ? 'AI 提及率' : '官方引用率',
            own: batch.overviewMetrics?.[`${language}:${engine}`]?.[metric] ?? summarizeMetric(rows, metric),
            target: summarizeMetricVerdicts(aiRows.map((row) => ({
              questionId: row.question.id,
              verdict: !row.observation ? null : metric === 'citation'
                ? targetCitation(row, batch, target, audits).verdict : targetMention(row, target, read),
            }))),
            ...(targetLimitations.length ? { targetLimitations } : {}),
          });
        }
      }
      for (const platform of platforms) {
        if (platform.ai || !['google', 'deepseek'].includes(platform.platform)) continue;
        metrics.push({
          id: platform.platform, label: platform.platform === 'google' ? 'Google 搜索命中' : 'DeepSeek 来源命中',
          own: ownSources(platform.rows),
          target: summarizeMetricVerdicts(platform.rows.map((row) => ({
            questionId: row.question.id, verdict: row.observation ? targetSource(row, target, read) : null,
          }))),
        });
      }
      const latest = rows.flatMap((row) => row.observation ? [row.observation] : [])
        .sort((a, b) => observationTime(b) - observationTime(a))[0];
      result.scopes[`${language}:${engine}`] = { metrics, ...(latest ? { measuredAt: latest.recordedAt } : {}) };
    }
  }
  return result;
}

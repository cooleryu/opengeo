import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { legacyAnswerAudit as legacyReviews } from './legacy-answer-audit';
import { readLatestResearch } from './research-store';
import { readRegisteredEvidence } from './diagnosis';
import { withGeoProject } from './projects';
import { analyzeResearchObservation } from './answer-audit';
import { saveAnswerAudit } from './answer-audit-store';
import ChatGPTModel, { type ChatGPTInferenceMetadata } from './chatgpt-model';
import type { CollectedAnswer } from './providers/types';
import type { AnswerAuditRecord } from './overview-metrics';

/** Reuse an already captured, independently checked answer. No new search is performed. */
export function findChatGPTVerificationAnswer(projectId: string) {
  return withGeoProject(projectId, () => {
    const batch = readLatestResearch(projectId);
    if (!batch) return null;
    for (const question of batch.questions) {
      for (const observation of question.observations) {
        if (observation.engine !== 'chatgpt') continue;
        const answerPath = observation.answerPath ?? observation.evidencePath;
        const reviewed = legacyReviews.records.find(item => item.projectId === projectId && item.batchId === batch.id
          && item.questionId === question.id && item.language === observation.language
          && item.recordedAt === observation.recordedAt && item.evidencePath === answerPath
          && item.answerComplete && item.citationCoverage === 'complete');
        if (!reviewed) continue;
        const raw = readRegisteredEvidence(observation.evidencePath.replace(/\.md$/, '.json'));
        if (!raw) continue;
        try {
          const captured = JSON.parse(raw);
          if (captured.project !== projectId || captured.id !== question.id || captured.language !== observation.language
            || captured.prompt !== observation.query || captured.observed_at_utc !== observation.recordedAt
            || typeof captured.answer_text !== 'string' || !captured.answer_text.trim()
            || !Array.isArray(captured.body_links) || !Array.isArray(captured.search_evidence)
            || !captured.search_evidence.includes('回答已完成')) continue;
          // body_links here are the collector's captured citation destinations, not general web results.
          // Completeness comes from the matching independent capture review above, never from this model.
          const citations = captured.body_links.map((link: { url: string; title: string }) => {
            if (!link || typeof link.title !== 'string' || !['http:', 'https:'].includes(new URL(link.url).protocol)) throw new Error();
            return { url: link.url, title: link.title };
          });
          const answer: CollectedAnswer = {
            text: captured.answer_text, citations, sources: [], searchPerformed: true, usage: {},
            evidence: { answerComplete: true, citationsComplete: true, citationSource: 'native' },
          };
          return { batch, question, observation, answer };
        } catch { /* An incomplete historical capture cannot prove this integration. */ }
      }
    }
    return null;
  });
}

export type ChatGPTVerification = {
  requestId: string;
  state: 'running' | 'complete' | 'failed';
  startedAt: string;
  completedAt?: string;
  projectId: string;
  question: string;
  collectedAt: string;
  evidencePath: string;
  provider: 'chatgpt-plan';
  inference?: ChatGPTInferenceMetadata;
  audit?: AnswerAuditRecord;
  error?: string;
};

const globals = globalThis as typeof globalThis & { __openGeoChatGPTVerification?: boolean };
const receiptFile = () => path.join(process.env.DATA_DIR || process.cwd(), 'data', 'chatgpt-analysis-verification.json');
export function readChatGPTVerification(): ChatGPTVerification | null {
  try {
    const file = receiptFile();
    if (fs.lstatSync(file).isSymbolicLink()) return null;
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8')) as ChatGPTVerification;
    if (receipt.state === 'running' && !globals.__openGeoChatGPTVerification) {
      return { ...receipt, state: 'failed', error: '上次验证被中断，是否已消耗额度未知；未自动重试。' };
    }
    return receipt;
  } catch { return null; }
}
function saveReceipt(receipt: ChatGPTVerification) {
  const file = receiptFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Unsafe receipt path');
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

/** An explicit one-answer proof. Never changes the existing DeepSeek configuration. */
export async function verifyChatGPTAnalysis(projectId: string, requestId: string): Promise<ChatGPTVerification> {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error('Invalid request');
  const previous = readChatGPTVerification();
  if (previous?.requestId === requestId) return previous;
  if (globals.__openGeoChatGPTVerification) throw new Error('Verification running');
  const selected = findChatGPTVerificationAnswer(projectId);
  if (!selected) throw new Error('No complete saved answer');
  let receipt: ChatGPTVerification = {
    requestId, state: 'running', startedAt: new Date().toISOString(), projectId,
    question: selected.observation.query, collectedAt: selected.observation.recordedAt,
    evidencePath: selected.observation.evidencePath, provider: 'chatgpt-plan',
  };
  globals.__openGeoChatGPTVerification = true;
  try {
    saveReceipt(receipt);
    let inference: ChatGPTInferenceMetadata | undefined;
    const model = new ChatGPTModel({ onMetadata: value => { inference = value; } });
    const audit = await analyzeResearchObservation(selected.batch, selected.question.id, selected.observation,
      selected.answer, { model, persist: () => {} });
    if (!inference || (audit.analysisStatus !== 'complete' && audit.analysisStatus !== 'needs_review')) {
      receipt = { ...receipt, state: 'failed', ...(inference ? { inference } : {}),
        error: audit.limitations?.[0] || '真实分析未完成，未更新原有判断；未自动重试。' };
    } else {
      saveAnswerAudit(audit);
      receipt = { ...receipt, state: 'complete', inference, audit };
    }
  } catch {
    receipt = { ...receipt, state: 'failed', error: '本次分析未完成，是否消耗额度请查看 ChatGPT 使用量；未自动重试。' };
  } finally {
    receipt.completedAt = new Date().toISOString();
    globals.__openGeoChatGPTVerification = false;
    saveReceipt(receipt);
  }
  return receipt;
}

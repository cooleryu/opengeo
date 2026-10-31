import type Database from 'better-sqlite3';
import type { GeoQuestionPlan, QuestionCandidate } from './question-types';
import type { ResearchBatch, ResearchQuestion } from './research-types';
import type { GeoSeed } from './types';
import { ResearchStoreError, saveResearchBatch } from './research-store';

function approved(candidate: QuestionCandidate): boolean {
  return candidate.review.status !== 'pending' && candidate.review.decision !== 'exclude' && !candidate.supersededByCandidateId;
}

/** Explicit confirmation freezes wording and review evidence; it never transfers observations. */
export function researchBatchFromPlan(plan: GeoQuestionPlan, seed: GeoSeed): ResearchBatch {
  if (plan.projectId !== seed.project.id) throw new ResearchStoreError('题单与当前项目不匹配。');
  if (plan.status !== 'ready') throw new ResearchStoreError('请先确认已审阅的题单。');
  const selected = plan.candidates.filter(candidate => candidate.selected);
  if (!selected.length || selected.length > 8) throw new ResearchStoreError('每批请选择 1—8 个核心问题。');
  if (selected.some(candidate => !approved(candidate))) throw new ResearchStoreError('题单中有待审阅、未通过审核或已被新版替代的问题。');
  const mapQuestion = (candidate: QuestionCandidate): ResearchQuestion => {
    const existing = candidate.origin === 'existing'
      ? seed.questions.find(question => question.id === candidate.originalQuestionId) : undefined;
    if (candidate.origin === 'existing' && (!existing || existing.query !== candidate.query)) throw new ResearchStoreError('历史题目的来源或原文不一致。');
    const englishOriginal = existing?.language.startsWith('en');
    return {
      id: existing?.id || candidate.id, candidateId: candidate.id, questionPlanRevision: plan.revision, category: candidate.category,
      zh: englishOriginal ? '' : candidate.query,
      en: candidate.queryEn || (englishOriginal ? candidate.query : ''),
      decision: candidate.selected ? 'search_now' : candidate.review.decision === 'exclude' ? 'drop_for_now' : 'keep_and_fill',
      valueReason: candidate.rationale,
      evidenceBasis: [candidate.demandStatus === 'unverified' ? '需求依据尚未验证；题目来自已保存的候选与审核判断。' : '',
        ...candidate.evidence.map(item => `${item.assetId}：${item.quote}`)].filter(Boolean).join('\n'),
      answerability: candidate.assetIds.length ? `关联材料：${candidate.assetIds.join('、')}。期待帮助：${candidate.expectedResult}；承接程度仍须核实。` : `尚未关联材料。期待帮助：${candidate.expectedResult}；缺少材料不等于没有能力。`,
      gaps: [...candidate.review.concerns], decisionReason: candidate.review.reason, reviewPath: '', observations: [],
      diagnosis: { observed: '本批尚未搜索。', hypothesis: '', nextStep: candidate.selected ? '按已确认原文搜索并保存结果。' : '保留候选及审核依据，后续再决定是否纳入。' },
    };
  };
  return {
    id: `${plan.id}:revision:${plan.revision}`, date: plan.updatedAt.slice(0, 10), updatedAt: plan.updatedAt,
    projectId: plan.projectId, questionPlan: structuredClone(plan), productSummary: plan.positioning,
    contributionSummary: '已有材料与逐题依据随已确认题单保存；尚未进行本批搜索。',
    scopeNote: '由用户明确确认的题单创建。中英问法按已保存原文分别搜索，缺少的语言未测；历史批次与观测保留在原批次。',
    reportPath: '', sourceAuditPath: '', reviewPath: '',
    questions: selected.map(mapQuestion), deferredQuestions: plan.candidates.filter(candidate => !candidate.selected).map(mapQuestion),
    nextStep: '对本批已确认的问题执行搜索。',
  };
}

export function saveResearchBatchFromPlan(plan: GeoQuestionPlan, seed: GeoSeed, connection?: Database.Database): ResearchBatch {
  const batch = researchBatchFromPlan(plan, seed);
  saveResearchBatch(plan.projectId, batch, connection);
  return batch;
}

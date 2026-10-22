import fs from 'node:fs';
import path from 'node:path';
import type { GeoProposal, GeoSeed, GeoTask } from './types';
import type { GeoDiagnosis, StrategyMemory } from './workflow-types';
import type { QualityIssue } from './quality';

type SourceExcerpt = { url: string; title: string; summary: string; snippet: string; content: string; contentProvided: boolean; truncated: boolean; boundary: string };
export interface DiagnosisContext {
  goal: string;
  project: GeoSeed['project'];
  protocolKey: string | null;
  baseline: { id: string; mode: string; status: string; measurementAt: string } | null;
  questions: { id: string; query: string; target: string; assetIds: string[]; exploratory: boolean; evidencePath: string;
    rawAvailable: boolean; measurementAt: string | null; resultCount: number | null; projectHit: boolean | null;
    sources: SourceExcerpt[]; suppliedSourceCount: number; boundary: string }[];
  materials: { id: string; title: string; publicUrl: string | null; sourcePath: string; summary: string; markdown: string;
    markdownIsExcerpt: boolean; truncated: boolean; boundary: string }[];
  strategies: StrategyMemory[];
  allowedEvidencePaths: string[];
  allowedTargetAssetIds: string[];
  evidenceReady: boolean;
  limitations: string[];
}

/** Read only a registered local evidence path; never fetch a URL or follow a path outside its root. */
function readRegisteredEvidence(file: string): string | null {
  if (!file || path.isAbsolute(file)) return null;
  const root = path.resolve(file.startsWith('data/geo-evidence/')
    ? process.env.DATA_DIR || process.cwd()
    : process.env.GEO_WORKSPACE || path.join(process.cwd(), '..'));
  try {
    const target = fs.realpathSync(path.resolve(root, file));
    if (!target.startsWith(fs.realpathSync(root) + path.sep) || !fs.statSync(target).isFile()
      || fs.statSync(target).size > 4 * 1024 * 1024) return null;
    return fs.readFileSync(target, 'utf8');
  } catch { return null; }
}

const text = (value: unknown, limit: number) => typeof value === 'string' ? value.slice(0, limit) : '';
export function buildDiagnosisContext(task: GeoTask, seed: GeoSeed, strategies: StrategyMemory[] = []): DiagnosisContext {
  const workflow = task.workflow;
  const baseline = workflow?.baseline;
  const frozen = workflow?.questions ?? [];
  const allowed = new Set<string>();
  let externalCharacters = 90_000;
  const excerpt = (value: unknown, limit: number) => {
    const result = text(value, Math.max(0, Math.min(limit, externalCharacters)));
    externalCharacters -= result.length;
    return result;
  };
  const questions = frozen.map(question => {
    const measured = baseline?.questions.find(item => item.id === question.id && item.query === question.query);
    const rawText = measured ? readRegisteredEvidence(measured.evidencePath) : null;
    let raw: { results?: unknown } | null = null;
    try { raw = rawText === null ? null : JSON.parse(rawText); } catch { /* Missing/malformed evidence stays unknown. */ }
    const results = raw && Array.isArray(raw.results) ? raw.results : null;
    const rawAvailable = results !== null && measured?.resultCount === results.length;
    if (rawAvailable && measured) allowed.add(measured.evidencePath);
    const sources: SourceExcerpt[] = (results ?? []).slice(0, 5).flatMap((item: unknown) => {
      if (!item || typeof item !== 'object') return [];
      const row = item as Record<string, unknown>;
      const url = text(row.url, 2048);
      try { if (!['https:', 'http:'].includes(new URL(url).protocol)) return []; } catch { return []; }
      const summary = excerpt(row.summary, 1500);
      const snippet = excerpt(row.snippet, 1500);
      const content = excerpt(row.content, 6000);
      const truncated = summary.length < text(row.summary, Number.MAX_SAFE_INTEGER).length
        || snippet.length < text(row.snippet, Number.MAX_SAFE_INTEGER).length || content.length < text(row.content, Number.MAX_SAFE_INTEGER).length;
      return [{ url, title: text(row.title, 500), summary, snippet,
        content, contentProvided: Boolean(content.trim()), truncated,
        boundary: '搜索服务返回的摘要、片段或正文；未独立抓取页面，content 存在也不能保证全文完整。' }];
    });
    return { id: question.id, query: question.query, target: question.target, assetIds: question.assetIds,
      exploratory: question.exploratory, evidencePath: measured?.evidencePath ?? '', rawAvailable,
      measurementAt: measured?.measurementAt ?? null, resultCount: results?.length ?? null, projectHit: measured?.projectHit ?? null,
      sources, suppliedSourceCount: sources.length, boundary: '每题最多提供前五条可读取来源；未提供的结果和页面内容属于未知。' };
  });
  const allowedTargetAssetIds = [...new Set(frozen.flatMap(question => question.assetIds))]
    .filter(id => seed.assets.some(asset => asset.id === id));
  let remaining = 100_000;
  const materials = seed.assets.map(asset => {
    const markdown = asset.markdown.slice(0, Math.min(20_000, remaining));
    remaining -= markdown.length;
    for (const file of [asset.sourcePath, ...asset.evidencePaths]) if (readRegisteredEvidence(file) !== null) allowed.add(file);
    return { id: asset.id, title: asset.title, publicUrl: asset.publicUrl, sourcePath: asset.sourcePath,
      summary: asset.summary, markdown, markdownIsExcerpt: Boolean(asset.markdownIsExcerpt), truncated: markdown.length !== asset.markdown.length,
      boundary: asset.markdownIsExcerpt || markdown.length !== asset.markdown.length
        ? '导入节选或输入截断；未见某信息不证明完整页面没有。只可修改明确提供的片段。'
        : '本地导入正文，未重新核验线上版本。' };
  });
  const categories = new Set(frozen.map(question => question.category));
  const applicable = strategies.filter(strategy => strategy.projectId === seed.project.id && strategy.protocolKey === workflow?.protocolKey
    && allowedTargetAssetIds.includes(strategy.targetAssetId) && strategy.categories.some(category => categories.has(category)));
  const evidenceReady = Boolean(baseline && baseline.mode === 'live' && baseline.status === 'completed' && frozen.length
    && baseline.protocolKey === workflow?.protocolKey && baseline.phase === 'baseline'
    && baseline.questions.length === frozen.length && baseline.completedCount === frozen.length
    && questions.every(question => question.rawAvailable));
  return { goal: task.goal, project: seed.project, protocolKey: workflow?.protocolKey ?? null,
    baseline: baseline ? { id: baseline.id, mode: baseline.mode, status: baseline.status, measurementAt: baseline.measurementAt } : null,
    questions, materials, strategies: applicable, allowedEvidencePaths: [...allowed], allowedTargetAssetIds,
    evidenceReady, limitations: ['网页搜索返回不等于 AI 回答引用；未命中不证明没有收录。',
      '生成与审核使用同一配置模型的独立上下文；通过不等于独立事实证明或外部效果验证。',
      '相似策略来自观察性结果，只能帮助提出假设，不能证明本次有效。',
      ...(!evidenceReady ? ['尚无与冻结题单匹配、原始证据完整的真实搜索基线，不能交付通过质量门槛的方案。'] : [])] };
}

export function localDiagnosis(context: DiagnosisContext): GeoDiagnosis {
  return { summary: context.evidenceReady ? '真实基线与原始返回已读取，尚待模型解释差异和原因。' : '当前只能预览本地材料；需要完整真实基线及审核配置。',
    findings: context.questions.map(question => ({ id: question.id,
      observation: question.rawAvailable ? `原始返回包含 ${question.resultCount} 条结果，已提供 ${question.suppliedSourceCount} 条来源片段。` : '原始搜索证据未读取或无效。',
      hypothesis: '未进行原因判断。', evidencePaths: question.rawAvailable ? [question.evidencePath] : [],
      uncertainty: '结果数量不代表来源质量；是否值得修改仍未审核。' })), comparisons: [],
    recommendedAction: context.evidenceReady ? '配置诊断与审核模型后核对差异，再决定是否修改。' : '先取得本题单的完整真实基线，再形成诊断。',
    limitations: context.limitations, source: 'local', createdAt: new Date().toISOString() };
}

export function validateDiagnosis(diagnosis: GeoDiagnosis, context: DiagnosisContext): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const reject = (detail: string) => issues.push({ dimension: 'evidence', severity: 'blocking', detail, suggestion: '仅引用本轮真实原始返回和已提供材料；没有证据时保留未知。' });
  if (!context.evidenceReady) reject('真实基线或原始证据不完整。');
  if (!diagnosis.findings.length) reject('诊断未提供可追溯的发现。');
  const seen = new Set<string>();
  for (const finding of diagnosis.findings) {
    if (seen.has(finding.id)) reject('诊断发现 ID 重复。');
    seen.add(finding.id);
    if (!finding.evidencePaths.length || finding.evidencePaths.some(file => !context.allowedEvidencePaths.includes(file))) reject('诊断引用了未提供或不可读取的证据。');
  }
  for (const comparison of diagnosis.comparisons) {
    const question = context.questions.find(item => item.id === comparison.questionId);
    if (!question || question.evidencePath !== comparison.evidencePath || !question.sources.some(source => source.url === comparison.sourceUrl)) reject('来源比较未绑定本题实际提供的搜索结果。');
  }
  return issues;
}

export function validateProposal(proposal: GeoProposal, seed: GeoSeed, context: DiagnosisContext): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const reject = (dimension: string, detail: string, suggestion: string) => issues.push({ dimension, severity: 'blocking', detail, suggestion });
  const asset = seed.assets.find(item => item.id === proposal.targetAssetId);
  if (!asset || !context.allowedTargetAssetIds.includes(proposal.targetAssetId)) reject('relevance', '目标材料不属于当前题单的承接范围。', '选择本轮问题绑定的真实材料。');
  if (!asset || proposal.targetUrl !== asset.publicUrl || !asset.publicUrl) reject('actionability', '目标地址与登记材料不一致。', '使用目标材料已登记的公开地址。');
  const material = context.materials.find(item => item.id === proposal.targetAssetId);
  if (!proposal.before.trim() || !material?.markdown.includes(proposal.before)) reject('evidence', '修改前原文无法定位于本次提供的材料。', '逐字引用本次可读的原文片段，只修改该片段。');
  else if (material.markdown.indexOf(proposal.before) !== material.markdown.lastIndexOf(proposal.before)) reject('actionability', '原文片段在材料中出现多次，修改位置不明确。', '补充相邻原文，使修改位置唯一。');
  if (!proposal.after.trim() || proposal.after === proposal.before) reject('actionability', '尚无具体有效的替换稿。', '提供要替换该片段的完整文字，不能只写建议。');
  if (/<\s*(script|iframe|object|embed)|\bon\w+\s*=|javascript\s*:/iu.test(proposal.after)) reject('actionability', '候选稿包含可执行或嵌入式标记。', '仅提交可审阅的正文内容，不携带脚本或事件处理器。');
  if (!proposal.evidencePaths.length || proposal.evidencePaths.some(file => !context.allowedEvidencePaths.includes(file))) reject('evidence', '方案包含未提供或不可读取的证据路径。', '只引用当前原始搜索返回和本地材料。');
  if (!proposal.evidencePaths.some(file => context.questions.some(question => question.rawAvailable && question.evidencePath === file))) reject('evidence', '方案未引用本轮搜索基线。', '把修改原因关联到本轮观测。');
  if (!proposal.successCriteria.length || !proposal.changes.length) reject('verifiability', '修改内容或验证标准缺失。', '说明具体修改、同入口复测条件与成功/停止条件。');
  return issues;
}

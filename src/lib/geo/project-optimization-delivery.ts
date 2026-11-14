import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readPublicSource } from './project-public-source';
import { currentGeoProject, evidenceLocation } from './projects';
import { loadProjectSeed } from './project-data';
import { editableAssetIssue, type AssetOwnershipScope } from './asset-ownership';
import type { ProjectOptimization, ProjectOptimizationAction } from './project-optimization-types';
import type { GeoAsset, ResearchTaskContext } from './types';

/** Complete owned text and its direct documentation links, without collecting new search results. */
export async function prepareOptimizationMaterials(plan: ProjectOptimization,
  read = readDeliveryMaterial): Promise<NonNullable<ProjectOptimization['preparedMaterials']>> {
  const assets = structuredClone(plan.snapshot.assets);
  const limitations: string[] = [];
  const readInto = async (asset: GeoAsset) => {
    try {
      const issue = editableAssetIssue(asset, plan.snapshot);
      if (issue) throw new Error(issue);
      const result = await read(asset);
      const index = assets.findIndex(item => item.id === asset.id);
      if (index < 0) assets.push(result.asset); else assets[index] = result.asset;
    } catch (error) {
      limitations.push(`${asset.title}：${error instanceof Error ? error.message : '完整正文未读到'} 不能据此认定产品缺少相关内容。`);
    }
  };
  const originals = assets.filter(asset => !editableAssetIssue(asset, plan.snapshot) && asset.publicUrl
    && /github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\/.+\.md$/i.test(asset.publicUrl)).slice(0, 4);
  await Promise.all(originals.map(readInto));
  const links: GeoAsset[] = [];
  for (const asset of assets.filter(item => originals.some(original => original.id === item.id))) {
    const base = new URL(asset.publicUrl!);
    const repositoryRoot = base.pathname.split('/').slice(0, 5).join('/') + '/';
    for (const match of asset.markdown.matchAll(/\[([^\]]+)\]\(([^\s)]+\.md)(?:#[^)]*)?\)/g)) {
      const url = new URL(match[2], base);
      if (url.origin !== base.origin || !url.pathname.startsWith(repositoryRoot)
        || assets.some(item => item.publicUrl === url.href) || links.some(item => item.publicUrl === url.href)) continue;
      links.push({ ...asset, id: `${asset.id}:linked:${links.length + 1}`, title: match[1], publicUrl: url.href,
        markdown: '', sourcePath: '', evidencePaths: [], markdownIsExcerpt: true });
    }
  }
  // One hop, at most two supporting documents; no recursive crawl.
  await Promise.all(links.slice(0, 2).map(readInto));
  return { assets, limitations };
}

/** Bridge a single-action plan to the existing editor without dropping companion actions. */
export function selectProjectDelivery(plan: ProjectOptimization, scope: AssetOwnershipScope = plan.snapshot): {
  action: ProjectOptimizationAction; asset: GeoAsset; context: ResearchTaskContext;
} {
  if (scope.project.id !== plan.snapshot.project.id) throw new Error('这项改动不属于当前项目。');
  if (plan.phase !== 'awaiting_review' || !plan.review?.passed)
    throw new Error('整体比较尚未通过审核，不能开始准备修改稿。');
  if (plan.actions.length > 1)
    throw new Error('本轮包含多项行动，现有改稿流程还不能完整处理；全部行动已保留，不能只交付第一项。');
  const action = plan.actions[0];
  if (!action || action.status !== 'ready' || !plan.review.actions.some(item => item.actionId === action.id && item.passed))
    throw new Error('优先行动尚未通过审核，不能交付实施。');
  // A multi-file change must not quietly turn into a partial single-file delivery.
  if (action.assetIds.length !== 1)
    throw new Error('这项行动需要新建内容或同时修改多份材料，尚不能作为一项完整改动交付。');
  const asset = (plan.preparedMaterials?.assets ?? plan.snapshot.assets).find(item => item.id === action.assetIds[0]);
  const ownershipIssue = editableAssetIssue(asset, scope);
  if (ownershipIssue) throw new Error(ownershipIssue);
  if (!asset?.publicUrl) throw new Error('还缺少这项改动的公开原文地址，需要先补齐材料。');
  for (const reference of action.evidence) {
    const evidence = plan.snapshot.evidence.find(item => item.id === reference.evidenceId);
    if (!evidence || !action.questionIds.includes(evidence.questionId)) continue;
    const question = plan.snapshot.questions.find(item => item.id === evidence.questionId && item.decision === 'search_now');
    if (!question || question[evidence.language] !== evidence.query) continue;
    const observation = question.observations.find(item => item.engine === evidence.engine && item.language === evidence.language
      && item.query === evidence.query && item.recordedAt === evidence.recordedAt
      && (item.evidencePath === evidence.evidencePath || item.answerPath === evidence.evidencePath));
    if (!observation) continue;
    return { action: structuredClone(action), asset: structuredClone(asset), context: {
      projectId: plan.snapshot.project.id, batchId: plan.batchId, questionId: question.id,
      language: evidence.language, engine: evidence.engine, purpose: 'improve_answer',
      targetAssetId: asset.id, targetUrl: asset.publicUrl,
      snapshot: { projectId: plan.snapshot.project.id, batchDate: plan.snapshot.batchDate,
        question: structuredClone(question), observations: [structuredClone(observation)],
        capturedAt: plan.frozenAt, candidateAssetIds: [asset.id], targetAsset: structuredClone(asset),
        reportPath: '', sourceAuditPath: '', reviewPath: '' },
    } };
  }
  throw new Error('没有找到与优先行动一致的原问题和完整采集记录，需要补齐后再改稿。');
}

/** Read the selected original once. Store it separately; never overwrite old evidence. */
export async function readDeliveryMaterial(asset: GeoAsset, scope: AssetOwnershipScope = loadProjectSeed(currentGeoProject())): Promise<{ asset: GeoAsset; readAt: string }> {
  const ownershipIssue = editableAssetIssue(asset, scope);
  if (ownershipIssue) throw new Error(ownershipIssue);
  const url = new URL(asset.publicUrl!);
  let sourceUrl = url.href;
  if (url.hostname === 'github.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[2] !== 'blob' || parts.length < 5) throw new Error('需要具体文件的公开地址，才能准确准备替换稿。');
    sourceUrl = `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts.slice(3).join('/')}`;
  }
  const source = await readPublicSource(sourceUrl, { maxBytes: 256 * 1024, timeoutMs: 20000, accept: 'text/plain, text/markdown' });
  // HTML extraction cannot provide an exact source-file patch. Keep that boundary explicit.
  if (/text\/html|application\/xhtml/i.test(source.contentType) || /^\s*<!doctype html|^\s*<html[\s>]/i.test(source.text))
    throw new Error('公开页只有网页渲染内容，还需要可编辑的正文原稿才能准备准确改动。');
  if (!source.text.trim()) throw new Error('没有读到目标材料正文。');
  const sourcePath = `data/geo-evidence/project-change-${randomUUID()}/original.md`;
  const { target } = evidenceLocation(sourcePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source.text, { mode: 0o600 });
  fs.writeFileSync(path.join(path.dirname(target), 'source.json'), JSON.stringify({ url: asset.publicUrl, fetchedUrl: source.url, readAt: source.readAt }), { mode: 0o600 });
  return { readAt: source.readAt, asset: { ...asset, markdown: source.text, markdownIsExcerpt: false,
    sourcePath, evidencePaths: [sourcePath], summary: `${asset.summary}\n本次完整读取于 ${source.readAt}。` } };
}

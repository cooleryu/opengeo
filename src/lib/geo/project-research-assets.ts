import type { ProjectResearchDocument } from './project-research-types';
import type { GeoAsset, GeoProject } from './types';
import { resolveAssetOwnership } from './asset-ownership';

export const researchAssetId = (projectId: string, sourceId: string) => `${projectId}-${sourceId}`;

/** A linked document is research material, not automatically owned content. */
export function researchDocumentAsset(projectId: string, document: ProjectResearchDocument, project: GeoProject): GeoAsset {
  if (project.id !== projectId) throw new Error('调查材料不属于当前项目。');
  const asset: GeoAsset = {
    id: researchAssetId(projectId, document.id), title: document.title, type: document.type,
    ownership: document.ownership ?? (document.origin === 'external' ? 'external' : 'unknown'),
    language: /[\u4e00-\u9fff]/u.test(document.markdown) ? 'zh' : 'en',
    status: 'external-reference', publishedAt: null,
    publicUrl: document.url, sourcePath: document.sourcePath, markdown: document.markdown,
    summary: '',
    evidencePaths: [document.sourcePath],
  };
  const { ownership } = resolveAssetOwnership(asset, { project, assets: [asset] });
  return { ...asset, ownership, status: ownership === 'owned' ? 'published' : 'external-reference',
    summary: ownership === 'owned' ? '已读取的项目公开资料。' : '外部参考，供需求与背景核对。' };
}

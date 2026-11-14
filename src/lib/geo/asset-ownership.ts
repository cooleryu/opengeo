import type { GeoAsset, GeoSeed } from './types';

export type EffectiveAssetOwnership = 'owned' | 'external';
export type AssetOwnershipScope = Pick<GeoSeed, 'project' | 'assets'>;
export interface AssetOwnership {
  ownership: EffectiveAssetOwnership;
  ownershipBasis: string;
}

function webUrl(value: string | null | undefined): URL | null {
  try {
    const url = new URL(value ?? '');
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      && !/%(?:2f|5c)/i.test(url.pathname) ? url : null;
  } catch { return null; }
}

function githubRepository(url: URL): string | null {
  if (!['github.com', 'raw.githubusercontent.com'].includes(url.hostname)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}/${parts[1].replace(/\.git$/i, '')}`.toLowerCase() : null;
}

function withinEntry(url: URL, entry: URL): boolean {
  const repository = githubRepository(entry);
  if (['github.com', 'raw.githubusercontent.com'].includes(entry.hostname))
    return Boolean(repository && githubRepository(url) === repository);
  const entryParts = entry.pathname.split('/').filter(Boolean);
  // A platform homepage (or GitLab namespace alone) is never a project boundary.
  if ((['gitlab.com', 'bitbucket.org', 'huggingface.co', 'npmjs.com', 'www.npmjs.com'].includes(entry.hostname) && entryParts.length < 2)
    || (['medium.com', 'www.youtube.com', 'youtube.com', 'x.com', 'twitter.com'].includes(entry.hostname) && !entryParts.length)) return false;
  if (url.origin !== entry.origin || (entry.search && url.search !== entry.search)
    || (entry.hash && url.hash !== entry.hash)) return false;
  const prefix = entry.pathname.replace(/\/$/, '');
  return url.pathname === entry.pathname || url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
}

/** Trusted entry paths, not hostnames or a model's ownership claim, define public ownership. */
export function isProjectOwnedUrl(value: string | null | undefined, project: Pick<GeoSeed['project'], 'repositoryUrl' | 'siteUrl'>): boolean {
  const url = webUrl(value);
  return Boolean(url && [project.repositoryUrl, project.siteUrl].some(value => {
    const entry = webUrl(value);
    return entry && withinEntry(url, entry);
  }));
}

function originalLocalAsset(asset: GeoAsset, scope: AssetOwnershipScope): boolean {
  return scope.assets.some(registered => {
    if (registered.id !== asset.id || registered.publicUrl !== asset.publicUrl
      || (!asset.publicUrl && registered.sourcePath !== asset.sourcePath)
      || registered.ownership === 'external' || registered.status === 'external-reference') return false;
    const sourcePath = registered.sourcePath?.replace(/\\/g, '/');
    // Use the registered original, never an incoming/fetched evidence path as proof.
    return Boolean(sourcePath && !sourcePath.startsWith('/') && !/^[a-z]+:/i.test(sourcePath)
      && !sourcePath.split('/').includes('..') && !/(^|\/)(?:geo-evidence|evidence)(\/|$)/i.test(sourcePath));
  });
}

/** Two effective classes; legacy missing/unknown metadata is left unchanged on disk. */
export function resolveAssetOwnership(asset: GeoAsset, scope: AssetOwnershipScope): AssetOwnership {
  const registered = scope.assets.find(item => item.id === asset.id);
  if (asset.ownership === 'external' || registered?.ownership === 'external')
    return { ownership: 'external', ownershipBasis: '项目资料明确登记为外部参考。' };
  if (registered?.ownership === 'owned' && registered.publicUrl === asset.publicUrl
    && (Boolean(asset.publicUrl) || registered.sourcePath === asset.sourcePath))
    return { ownership: 'owned', ownershipBasis: '当前项目已明确登记这份材料为自有内容。' };
  if (isProjectOwnedUrl(asset.publicUrl, scope.project))
    return { ownership: 'owned', ownershipBasis: '公开地址位于当前项目登记的仓库或站点路径内。' };
  const url = webUrl(asset.publicUrl);
  // A saved copy cannot turn another GitHub repository into this project's target.
  if (url && ['github.com', 'raw.githubusercontent.com'].includes(url.hostname))
    return { ownership: 'external', ownershipBasis: '公开地址不属于当前项目登记的仓库。' };
  if (url && [scope.project.siteUrl, scope.project.repositoryUrl].some(value => webUrl(value)?.origin === url.origin))
    return { ownership: 'external', ownershipBasis: '公开地址超出了当前项目登记的站点路径。' };
  if (originalLocalAsset(asset, scope))
    return { ownership: 'owned', ownershipBasis: '当前项目已明确登记这份本地原稿及其发布地址；证据缓存不作为归属依据。' };
  return { ownership: 'external', ownershipBasis: '未对应到当前项目的仓库、站点路径或已登记本地原稿，作为外部参考使用。' };
}

/** Shared by generation, independent review and the final edit handoff. */
export function editableAssetIssue(asset: GeoAsset | undefined, scope: AssetOwnershipScope): string | null {
  if (!asset) return '目标材料不属于当前项目。';
  return resolveAssetOwnership(asset, scope).ownership === 'owned' ? null
    : `材料「${asset.title}」是外部参考，不能作为可修改的自有内容。`;
}

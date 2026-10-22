import data from './data/contextadapt.json';
import type { GeoSeed } from './types';
export function getSeed(): GeoSeed {
  const seed = structuredClone(data);
  return { ...seed, proposal: { ...seed.proposal, changes: seed.proposal.changes.map((change) => `${change.title}：${change.detail}`) } } as unknown as GeoSeed;
}

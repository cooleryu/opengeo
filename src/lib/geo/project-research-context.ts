import { readLatestProjectResearch } from './project-research-store';
import { projectDataDirectory, withGeoProject } from './projects';
import { researchAssetId } from './project-research-assets';
import type { ProjectResearchSnapshot } from './project-research-types';

export function projectResearch(projectId: string): ProjectResearchSnapshot | null {
  return readLatestProjectResearch(withGeoProject(projectId, projectDataDirectory), projectId);
}

/** Planning receives source-backed relationships, not another set of topic rules. */
export function projectResearchContext(projectId: string) {
  const research = projectResearch(projectId);
  if (!research) return null;
  return {
    runId: research.runId, status: research.status, limitations: research.limitations,
    relations: research.relations.map(relation => ({ ...relation,
      evidence: relation.evidence.map(evidence => ({ ...evidence,
        assetId: researchAssetId(projectId, evidence.sourceId) })),
    })),
  };
}

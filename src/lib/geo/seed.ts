import { loadProjectSeed } from './project-data';
import { currentGeoProject } from './projects';
import type { GeoSeed } from './types';
export function getSeed(): GeoSeed {
  return loadProjectSeed(currentGeoProject());
}

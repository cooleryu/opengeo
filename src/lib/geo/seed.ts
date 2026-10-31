import exampleProject from './data/example-project.json';
import exampleProjectTwo from './data/example-project-two.json';
import { currentGeoProject } from './projects';
import type { GeoSeed } from './types';

export function getSeed(): GeoSeed {
  const seed = currentGeoProject() === 'example-project-two' ? exampleProjectTwo : exampleProject;
  return structuredClone(seed) as GeoSeed;
}

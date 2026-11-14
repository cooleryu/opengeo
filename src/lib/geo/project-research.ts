import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GeoStructuredModel } from './connection-settings';
import { discoverProjectResearch, researchDocumentId } from './project-research-discovery';
import { appendProjectResearch } from './project-research-store';
import { projectDataDirectory, withGeoProject } from './projects';
import type { ProjectResearchDocument, ProjectResearchSnapshot } from './project-research-types';
import { isProjectOwnedUrl } from './asset-ownership';

type ReadDocument = Pick<ProjectResearchDocument, 'title' | 'url' | 'markdown' | 'readAt' | 'type'>;
export type ProjectResearchSearch = (query: string) => Promise<{
  results: { title: string; url: string }[];
  confirmedCostCny: number | null;
  reservedCostCny: number;
  error?: string;
}>;

function ownership(document: ProjectResearchDocument, entry: string): 'owned' | 'external' {
  if (document.ownership === 'external') return 'external';
  return isProjectOwnedUrl(document.url, { repositoryUrl: entry, siteUrl: entry }) ? 'owned' : 'external';
}

/** The web onboarding step saves every actual read before continuing model work. */
export async function researchProject(input: {
  projectId: string; entry: string; notes: string; documents: ReadDocument[]; limitations: string[];
  model: GeoStructuredModel; readDocument: (url: string) => Promise<ReadDocument>;
  search?: ProjectResearchSearch; discover?: boolean; onProgress?: (message: string) => void;
}): Promise<ProjectResearchSnapshot> {
  const directory = withGeoProject(input.projectId, projectDataDirectory);
  const bundle = `onboarding-${randomUUID()}`;
  const evidenceDirectory = path.join(directory, 'geo-evidence', bundle);
  fs.mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  const documents: ProjectResearchDocument[] = [];
  const searches: NonNullable<ProjectResearchSnapshot['searches']> = [];
  let snapshot: ProjectResearchSnapshot;
  let storageError: unknown;
  const save = (relations: ProjectResearchSnapshot['relations'] = [], limitations = input.limitations, completed = false) => {
    snapshot = { version: 1, projectId: input.projectId, runId: `${bundle}-${randomUUID()}`,
      createdAt: new Date().toISOString(), status: completed ? 'completed' : 'partial',
      documents: structuredClone(documents), relations, limitations, searches: structuredClone(searches) };
    try { appendProjectResearch(directory, snapshot); }
    catch (error) { storageError = error; throw error; }
    return snapshot;
  };
  const preserve = (document: ProjectResearchDocument) => {
    document.sourcePath = `data/geo-evidence/${bundle}/${document.id}.md`;
    document.ownership = ownership(document, input.entry);
    fs.writeFileSync(path.join(evidenceDirectory, `${document.id}.md`), document.markdown, { mode: 0o600 });
    if (!documents.some(existing => existing.id === document.id)) documents.push(document);
    save();
  };
  for (const [index, document] of input.documents.entries()) preserve({ ...document,
    id: researchDocumentId(document.url, document.markdown), origin: index === 0 ? 'entry' : 'linked', sourcePath: '' });
  if (input.discover === false) return save([], input.limitations, true);
  const result = await discoverProjectResearch({ documents, notes: input.notes, model: input.model,
    readDocument: input.readDocument, onDocument: preserve,
    onProgress: message => { if (storageError) throw storageError; input.onProgress?.(message); },
    search: input.search ? async query => {
      const search: NonNullable<ProjectResearchSnapshot['searches']>[number] = {
        query, requestedAt: new Date().toISOString(), status: 'pending', confirmedCostCny: null,
        reservedCostCny: 0.005, results: [],
      };
      searches.push(search);
      save();
      let result: Awaited<ReturnType<ProjectResearchSearch>>;
      try { result = await input.search!(query); }
      catch { result = { results: [], confirmedCostCny: null, reservedCostCny: 0.005, error: '补充搜索未完成。' }; }
      Object.assign(search, { status: result.error ? 'failed' : 'completed', results: result.results,
        confirmedCostCny: result.confirmedCostCny, reservedCostCny: result.reservedCostCny });
      save();
      if (result.error) throw new Error('补充搜索未完成。');
      return result.results;
    } : undefined,
  });
  if (storageError) throw storageError;
  const limitations = [...new Set([...input.limitations, ...result.limitations])];
  return save(result.relations, limitations, limitations.length === 0);
}

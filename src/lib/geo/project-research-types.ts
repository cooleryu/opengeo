/** Sources and relationships produced by the application's project research step. */
export interface ProjectResearchDocument {
  id: string;
  title: string;
  url: string;
  markdown: string;
  readAt: string;
  type: string;
  origin: 'entry' | 'linked' | 'external';
  ownership?: 'owned' | 'external' | 'unknown';
  sourcePath: string;
}

export interface ProjectResearchRelation {
  id: string;
  kind: 'capability' | 'contribution' | 'need';
  statement: string;
  audience: string;
  basis: 'source' | 'inferred';
  evidence: { sourceId: string; quote: string }[];
}

export interface ProjectResearchSnapshot {
  version: 1;
  projectId: string;
  runId: string;
  createdAt: string;
  status: 'completed' | 'partial';
  documents: ProjectResearchDocument[];
  relations: ProjectResearchRelation[];
  limitations: string[];
  searches?: {
    query: string;
    requestedAt: string;
    status: 'pending' | 'completed' | 'failed';
    confirmedCostCny: number | null;
    reservedCostCny: number;
    results: { title: string; url: string }[];
  }[];
}

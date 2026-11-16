import fs from 'node:fs';
import path from 'node:path';
import { projectDataDirectory, withGeoProject } from '../projects';
import type { ResearchEngine } from '../research-types';

export type OutreachActionKind = 'repo_meta' | 'awesome_pr' | 'community_post';
export type OutreachActionStatus = 'suggested' | 'prepared' | 'completed' | 'skipped';

export interface RepoMetaDraft {
  owner: string;
  repo: string;
  currentDescription: string;
  currentHomepage: string;
  currentTopics: string[];
  suggestedDescription: string;
  suggestedHomepage: string;
  suggestedTopics: string[];
}

export interface AwesomePrDraft {
  upstreamOwner: string;
  upstreamRepo: string;
  defaultBranch: string;
  sectionHeading: string;
  insertedLine: string;
  contextSnippet: string;
  prTitle: string;
  prBody: string;
}

export interface CommunityPostDraft {
  channelLabel: string;
  submitUrl: string;
  draftTitle: string;
  draftBody: string;
  draftUrl?: string;
}

export interface OutreachActionRecord {
  id: string;
  kind: OutreachActionKind;
  title: string;
  subtitle: string;
  targetUrl: string;
  citedCount?: number;
  citedEngines?: ResearchEngine[];
  status: OutreachActionStatus;
  repoMetaDraft?: RepoMetaDraft;
  awesomePrDraft?: AwesomePrDraft;
  postDraft?: CommunityPostDraft;
  resultUrl?: string;
  note?: string;
  completedAt?: string;
  updatedAt: string;
}

interface OutreachStorePayload {
  version: 1;
  records: OutreachActionRecord[];
}

function outreachFilePath(): string {
  return path.join(projectDataDirectory(), 'outreach-actions.json');
}

export function readOutreachRecords(projectId: string): OutreachActionRecord[] {
  return withGeoProject(projectId, () => {
    const file = outreachFilePath();
    if (!fs.existsSync(file)) return [];
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<OutreachStorePayload>;
      return Array.isArray(raw.records) ? raw.records : [];
    } catch {
      return [];
    }
  });
}

export function getOutreachRecord(
  projectId: string,
  actionId: string,
): OutreachActionRecord | null {
  return readOutreachRecords(projectId).find((item) => item.id === actionId) ?? null;
}

export function upsertOutreachRecord(
  projectId: string,
  record: OutreachActionRecord,
): OutreachActionRecord {
  return withGeoProject(projectId, () => {
    const file = outreachFilePath();
    const existing = readOutreachRecords(projectId);
    const nextRecord: OutreachActionRecord = {
      ...record,
      updatedAt: new Date().toISOString(),
    };
    const idx = existing.findIndex((item) => item.id === record.id);
    const records =
      idx >= 0
        ? existing.map((item, i) => (i === idx ? nextRecord : item))
        : [...existing, nextRecord];

    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ version: 1, records } satisfies OutreachStorePayload, null, 2),
      'utf8',
    );
    fs.renameSync(tmp, file);
    return nextRecord;
  });
}

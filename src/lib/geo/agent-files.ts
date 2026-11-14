import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';

function agentFile(agentId: string, fileName: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agentId) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*\.(md|json)$/.test(fileName)) {
    throw new Error('Invalid Agent file identifier');
  }
  const baseDir = path.resolve(process.cwd(), 'skills', agentId);
  const target = path.resolve(baseDir, fileName);
  if (!target.startsWith(`${baseDir}${path.sep}`)) {
    throw new Error('Invalid Agent file path traversal');
  }
  return target;
}

/** Parses simple `key: value` metadata inside leading YAML frontmatter. */
export function parseAgentFrontmatter(source: string): Record<string, string> {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return {};
  const meta: Record<string, string> = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (key) meta[key] = val;
  }
  return meta;
}

/** Reads YAML frontmatter metadata tags from a requested skill file. */
export function readAgentMeta(agentId: string, fileName = 'SKILL.md'): Record<string, string> {
  const source = fs.readFileSync(agentFile(agentId, fileName), 'utf8');
  return parseAgentFrontmatter(source);
}

/** Read only the requested role instructions; never load the whole Skill catalogue. */
export function readAgentText(agentId: string, fileName = 'SKILL.md'): string {
  const source = fs.readFileSync(agentFile(agentId, fileName), 'utf8');
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
  if (!body) throw new Error(`Agent instructions are empty: ${agentId}/${fileName}`);
  return body;
}

/** Parameters have one file source and are validated by their existing caller. */
export function readAgentParameters<T>(agentId: string, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(fs.readFileSync(agentFile(agentId, 'parameters.json'), 'utf8')));
}

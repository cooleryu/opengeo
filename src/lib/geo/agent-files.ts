import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';

function agentFile(agentId: string, fileName: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agentId) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(md|json)$/.test(fileName)) {
    throw new Error('Invalid Agent file identifier');
  }
  return path.join(process.cwd(), 'skills', agentId, fileName);
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

import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import fs from 'node:fs/promises';
import { getSeed } from '@/lib/geo/seed';
import { getGeoState } from '@/lib/geo/store';
import { visibilityEvidencePaths } from '@/lib/geo/visibility';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const file = request.nextUrl.searchParams.get('path') || '';
  const seed = getSeed();
  const state = getGeoState();
  const runs = state.tasks.flatMap(task => [
    ...task.runs,
    ...[task.workflow, ...(task.workflowHistory || [])].flatMap(workflow => workflow?.baseline ? [workflow.baseline] : []),
  ]);
  const allowed = new Set([
    ...seed.assets.flatMap(a=>[a.sourcePath,...a.evidencePaths]),
    ...seed.questions.map(q=>q.evidencePath),
    ...seed.observations.map(o=>o.sourcePath),
    ...seed.findings.flatMap(f=>f.evidencePaths),
    ...seed.proposal.evidencePaths,
    ...runs.flatMap(run => [`data/geo-evidence/${run.id}/run.json`, ...run.questions.map(question => question.evidencePath)]),
    ...state.observations.map(o=>o.sourcePath),
    ...state.questions.map(q=>q.evidencePath),
    ...state.visibility.questions.flatMap(q=>q.results.flatMap(r=>r.evidencePath ? [r.evidencePath] : [])),
    ...visibilityEvidencePaths,
  ]);
  if (!allowed.has(file)) return NextResponse.json({error:'这份材料不在当前项目的证据中。'},{status:404});
  const isRunEvidence = /^data\/geo-evidence\//.test(file);
  const root = isRunEvidence ? path.resolve(process.env.DATA_DIR || process.cwd()) : path.resolve(process.env.GEO_WORKSPACE || path.join(process.cwd(),'..'));
  const target = path.resolve(root,file);
  if (!target.startsWith(root+path.sep)) return NextResponse.json({error:'材料路径无效。'},{status:400});
  try {
    const actual = await fs.realpath(target);
    if (!actual.startsWith(root+path.sep)) throw new Error('Invalid path');
    const content = await fs.readFile(actual,'utf8');
    const extension = path.extname(file);
    return NextResponse.json({path:file,content:content.slice(0,200000),format:extension==='.md'?'markdown':extension==='.json'?'json':extension==='.html'?'html':'text'},{headers:{'Cache-Control':'no-store'}});
  } catch { return NextResponse.json({error:'原始材料当前无法读取；导入的记录仍可查看。'},{status:404}); }
}

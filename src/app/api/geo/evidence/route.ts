import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import fs from 'node:fs/promises';
import { getSeed } from '@/lib/geo/seed';
import { getGeoState } from '@/lib/geo/store';
import { visibilityEvidencePaths } from '@/lib/geo/visibility';
import { researchEvidencePaths, listResearchRuns, listResearchBatches } from '@/lib/geo/research';
import { evidenceLocation, GeoProjectError, withGeoProject } from '@/lib/geo/projects';
import { extractAnswerContent } from '@/lib/geo/answer-content';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try { return await withGeoProject(request.nextUrl.searchParams.get('project'), () => readProjectEvidence(request)); }
  catch (error) {
    return NextResponse.json({ error: error instanceof GeoProjectError ? error.message : '材料当前无法读取。' }, { status: error instanceof GeoProjectError ? error.status : 500 });
  }
}

async function readProjectEvidence(request: NextRequest) {
  const file = request.nextUrl.searchParams.get('path') || '';
  const seed = getSeed();
  const state = getGeoState();
  const batches = listResearchBatches(seed.project.id);
  const runs = state.tasks.flatMap(task => [
    ...task.runs,
    ...[task.workflow, ...(task.workflowHistory || [])].flatMap(workflow => workflow?.baseline ? [workflow.baseline] : []),
  ]);
  const allowed = new Set([
    ...batches.flatMap(researchEvidencePaths),
    ...listResearchRuns(seed.project.id).flatMap(run => run.evidencePath ? [run.evidencePath] : []),
    ...seed.assets.flatMap(a=>[a.sourcePath,...a.evidencePaths]),
    ...seed.questions.map(q=>q.evidencePath),
    ...seed.observations.map(o=>o.sourcePath),
    ...seed.findings.flatMap(f=>f.evidencePaths),
    ...seed.proposal.evidencePaths,
    ...runs.flatMap(run => [`data/geo-evidence/${run.id}/run.json`, ...run.questions.map(question => question.evidencePath)]),
    ...state.observations.map(o=>o.sourcePath),
    ...state.questions.map(q=>q.evidencePath),
    ...state.visibility.questions.flatMap(q=>q.results.flatMap(r=>r.evidencePath ? [r.evidencePath] : [])),
  ]);
  if (!allowed.has(file)) return NextResponse.json({error:'这份材料不在当前项目的证据中。'},{status:404});
  const { root, target } = evidenceLocation(file);
  if (!target.startsWith(root+path.sep)) return NextResponse.json({error:'材料路径无效。'},{status:400});
  try {
    const actualRoot = await fs.realpath(root);
    const actual = await fs.realpath(target);
    if (!actual.startsWith(actualRoot+path.sep)) throw new Error('Invalid path');
    const content = await fs.readFile(actual,'utf8');
    if (request.nextUrl.searchParams.get('view') === 'answer') {
      const observations = batches.flatMap(batch => [...batch.questions, ...batch.deferredQuestions].flatMap(question => question.observations));
      const isSearchEvidence = observations.some(observation => observation.evidencePath === file && (
        observation.entryType === 'web_search' || observation.entryType === 'api_search' ||
        (!observation.entryType && (observation.engine === 'google' || observation.engine === 'deepseek'))
      ));
      const standalone = file.endsWith('.answer.md') && observations.some(observation =>
        observation.entryType === 'api_answer' && observation.answerPath === file,
      );
      const answer = isSearchEvidence ? null : extractAnswerContent(content, { standalone });
      return NextResponse.json({ path: file, content: answer, format: 'markdown', status: answer === null ? 'unavailable' : 'available' }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const extension = path.extname(file);
    return NextResponse.json({path:file,content:content.slice(0,200000),format:extension==='.md'?'markdown':extension==='.json'?'json':extension==='.html'?'html':'text'},{headers:{'Cache-Control':'no-store'}});
  } catch { return NextResponse.json({error:'原始材料当前无法读取；导入的记录仍可查看。'},{status:404}); }
}

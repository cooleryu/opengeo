import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defaultAgentHub, type HumanProgressStep, type LLMTransport } from '../../agent-hub';
import { isProjectOwnedUrl } from '../asset-ownership';
import { answerAuditorAgent } from '../agents/auditor-agent';
import { resolveOwnedAssetContent } from '../agents/project-tools';
import {
  ensureProjectRelationalData,
  ingestRelationalObservation,
  readRelationalOverview,
  withProjectDb,
  type OptimizationRunMode,
} from '../db';
import { resolveProjectTargetLanguage, resolveProjectUiLanguage } from '../i18n';
import { loadProjectSeed } from '../project-data';
import { projectDataDirectory, withGeoProject } from '../projects';
import { getCollectionConfig, requireCollectionKey } from '../providers/config';
import { buildDoubaoRequest, parseDoubaoAnswer } from '../providers/doubao';
import { buildQwenRequest, parseQwenAnswer } from '../providers/qwen';
import type { CollectedAnswer } from '../providers/types';
import type { ResearchEngine, ResearchObservation } from '../research-types';
import {
  chineseCompanionAgent,
  deliverableReviewerAgent,
  deliverableWriterAgent,
  optimizationStrategistAgent,
} from './agents';
import {
  appendRunProgress,
  createOptimizationRunRecord,
  getOptimizationRun,
  insertDeliverableSkeleton,
  OptimizationStateError,
  transitionOptimizationRun,
  updateDeliverableRecord,
} from './repository';
import { selectAndProbeReferenceWinners } from './reference-winners';
import type {
  DeliverableCompanionFile,
  DeliverableReviewResult,
  OptimizationRun,
  ReferenceWinner,
} from './types';

function normalizeDeliverableContent(
  kind: 'update_asset' | 'new_content',
  format: 'rich_markdown' | 'web_html',
  title: string,
  afterContent: string,
): string {
  const trimmed = afterContent.trim();
  if (kind === 'new_content' && format === 'rich_markdown' && !trimmed.startsWith('# ')) {
    return `# ${title.trim()}\n\n${trimmed}\n`;
  }
  return `${trimmed}\n`;
}

function buildBilingualCompanionFiles(
  projectId: string,
  destination: string,
  beforeContent: string,
  targetLanguage?: 'en' | 'zh',
): DeliverableCompanionFile[] {
  if (targetLanguage !== 'en' || !beforeContent) {
    return [];
  }
  const stripped = beforeContent.replace(
    /\[[^\]]{1,24}\]\([^)\s]*\.zh-CN\.md\)|<a\s[^>]*href=["'][^"']*\.zh-CN\.md["'][^>]*>[^<]{1,24}<\/a>/gi,
    '',
  );
  const hanCount = (stripped.match(/[\p{Script=Han}]/gu) ?? []).length;
  if (hanCount < 50) {
    return [];
  }
  const repoUrl = (loadProjectSeed(projectId).project.repositoryUrl || '').toLowerCase();
  if (!repoUrl.includes('github.com/cooleryu/opengeo')) {
    return [];
  }
  const rel = destination
    .trim()
    .replace(/^https?:\/\/github\.com\/cooleryu\/opengeo\/blob\/[^/]+\//i, '')
    .replace(/^\/+/, '');
  if (/^README\.md$/i.test(rel)) {
    if (fs.existsSync(path.resolve(process.cwd(), 'README.zh-CN.md'))) {
      return [];
    }
    const adaptedZh = beforeContent
      .replace(/README\.en\.md/g, 'README.md')
      .replace(/\(docs\/getting-started\.md\)/g, '(docs/getting-started.zh-CN.md)');
    return [
      {
        path: 'README.zh-CN.md',
        label: '简体中文',
        lang: 'zh-CN',
        content: adaptedZh,
        deletePaths: ['README.en.md'],
      },
    ];
  }
  if (/^docs\/getting-started\.md$/i.test(rel)) {
    if (fs.existsSync(path.resolve(process.cwd(), 'docs/getting-started.zh-CN.md'))) {
      return [];
    }
    const adaptedZh = beforeContent.replace(/README\.en\.md/g, 'README.md');
    return [
      {
        path: 'docs/getting-started.zh-CN.md',
        label: '简体中文',
        lang: 'zh-CN',
        content: adaptedZh,
      },
    ];
  }
  return [];
}

function resolveDefaultPreferredProvider(
  explicit?: 'gemini' | 'deepseek',
  transport?: LLMTransport,
): 'gemini' | 'deepseek' | undefined {
  if (explicit) return explicit;
  if (transport) return undefined;
  if (process.env.GEMINI_API_KEY?.trim()) return 'gemini';
  return undefined;
}

interface CompanionMetadata {
  path: string;
  label: string;
  lang: string;
  reviewOnly: boolean;
  isRepoDoc: boolean;
  deletePaths?: string[];
}

function buildCompanionMetadata(
  projectId: string,
  destination: string,
  deliverableId: string,
): CompanionMetadata {
  const seed = loadProjectSeed(projectId);
  const repoUrl = (seed.project.repositoryUrl || '').toLowerCase();
  const isOpenGeoRepo = repoUrl.includes('github.com/cooleryu/opengeo');
  const rel = destination
    .trim()
    .replace(/^https?:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\//i, '')
    .replace(/^\/+/, '');

  if (/^README\.md$/i.test(rel)) {
    return {
      path: 'README.zh-CN.md',
      label: '简体中文',
      lang: 'zh-CN',
      reviewOnly: false,
      isRepoDoc: true,
      ...(isOpenGeoRepo ? { deletePaths: ['README.en.md'] } : {}),
    };
  }
  if (/^docs\/getting-started\.md$/i.test(rel)) {
    return {
      path: 'docs/getting-started.zh-CN.md',
      label: '简体中文',
      lang: 'zh-CN',
      reviewOnly: false,
      isRepoDoc: true,
    };
  }
  if (/^docs\/[a-zA-Z0-9._/-]+\.md$/i.test(rel) && !/^https?:\/\//i.test(destination.trim())) {
    const normalized = rel.replace(/\.zh-CN\.md$/i, '.md').replace(/\.md$/i, '.zh-CN.md');
    return {
      path: normalized,
      label: '中文对照',
      lang: 'zh-CN',
      reviewOnly: true,
      isRepoDoc: false,
    };
  }
  const safeId = deliverableId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'article';
  return {
    path: `docs/blog/${safeId}.zh-CN.md`,
    label: '中文对照',
    lang: 'zh-CN',
    reviewOnly: true,
    isRepoDoc: false,
  };
}

function mergeZhCompanionFile(
  existing: DeliverableCompanionFile[] | undefined,
  nextFile: DeliverableCompanionFile,
): DeliverableCompanionFile[] {
  const preserved = (existing ?? []).filter((item) => item.lang !== nextFile.lang);
  return [...preserved, nextFile];
}

async function generateZhCompanionForDeliverable(
  projectId: string,
  deliv: {
    id: string;
    title: string;
    destination: string;
    audienceAndGoal: string;
    afterContent: string;
    beforeContent: string;
    companionFiles?: DeliverableCompanionFile[];
  },
  options: {
    transport?: LLMTransport;
    preferredProvider?: 'gemini' | 'deepseek';
    onProgress?: (step: HumanProgressStep) => void;
    signal?: AbortSignal;
  },
): Promise<DeliverableCompanionFile[]> {
  const englishContent = (deliv.afterContent || deliv.beforeContent || '').trim();
  if (!englishContent) {
    throw new OptimizationStateError('当前交付稿尚无英文成稿内容，无法生成中文对照版。', 400);
  }
  const meta = buildCompanionMetadata(projectId, deliv.destination, deliv.id);
  const companionRes = await defaultAgentHub.run(
    chineseCompanionAgent,
    {
      title: deliv.title,
      destination: deliv.destination,
      audienceAndGoal: deliv.audienceAndGoal,
      englishContent,
      companionPath: meta.path,
      isRepoDoc: meta.isRepoDoc,
    },
    {
      projectId,
      transport: options.transport,
      preferredProvider: options.preferredProvider,
      onProgress: options.onProgress,
      signal: options.signal,
    },
  );
  const nextFile: DeliverableCompanionFile = {
    path: meta.path,
    label: meta.label,
    lang: meta.lang,
    content: `${companionRes.output.content.trim()}\n`,
    reviewOnly: meta.reviewOnly,
    ...(meta.deletePaths ? { deletePaths: meta.deletePaths } : {}),
  };
  return mergeZhCompanionFile(deliv.companionFiles, nextFile);
}

export interface StartOptimizationOptions {
  mode?: OptimizationRunMode;
  targetLanguage?: 'en' | 'zh';
  includeChineseCompanion?: boolean;
  transport?: LLMTransport;
  preferredProvider?: 'gemini' | 'deepseek';
  probeWinners?: typeof selectAndProbeReferenceWinners;
  onProgress?: (step: HumanProgressStep, runStatus: OptimizationRun['status']) => void;
  signal?: AbortSignal;
}

export async function startOptimizationRun(
  projectId: string,
  options: StartOptimizationOptions = {},
): Promise<OptimizationRun> {
  const mode = options.mode ?? 'deep';
  const preferredProvider = resolveDefaultPreferredProvider(options.preferredProvider, options.transport);
  const seed = loadProjectSeed(projectId);
  const targetLanguage =
    options.targetLanguage ??
    seed.project.targetLanguage ??
    resolveProjectTargetLanguage(seed.project, readRelationalOverview(projectId));
  const uiLanguage = resolveProjectUiLanguage({
    uiLanguage: seed.project.uiLanguage,
    summaryOrDescription: seed.project.description,
  });
  const winnerProber =
    options.probeWinners ??
    (options.transport?.provider === 'test'
      ? async () => [] as ReferenceWinner[]
      : selectAndProbeReferenceWinners);
  let run = createOptimizationRunRecord(
    projectId,
    mode,
    '正在梳理项目的全部监测问题与真实搜索回答，寻找最关键的突破口…',
  );

  const emitProgress = (step: HumanProgressStep) => {
    appendRunProgress(projectId, run.id, step);
    options.onProgress?.(step, run.status);
  };

  try {
    const planRes = await defaultAgentHub.run(
      optimizationStrategistAgent,
      { mode, targetLanguage, uiLanguage },
      {
        projectId,
        transport: options.transport,
        preferredProvider,
        onProgress: emitProgress,
        signal: options.signal,
      },
    );

    const activeQuestions = withProjectDb(projectId, (db, id) => {
      ensureProjectRelationalData(id, db);
      return db
        .prepare(
          "SELECT id, query_zh AS queryZh, query_en AS queryEn FROM opengeo_questions WHERE project_id = ? AND status = 'active'",
        )
        .all(id) as Array<{ id: string; queryZh: string; queryEn: string }>;
    });
    const questionLookup = new Map(activeQuestions.map((q) => [q.id, q]));

    const createdDeliverables = planRes.output.deliverables.map((planned) => {
      let beforeContent =
        planned.kind === 'update_asset' && planned.targetAssetId
          ? (resolveOwnedAssetContent(projectId, planned.targetAssetId).markdown ?? '')
          : '';
      if (!beforeContent) {
        const existingDocPath = resolveSafeNewDocPath(projectId, planned.destination);
        if (existingDocPath && fs.existsSync(existingDocPath)) {
          beforeContent = fs.readFileSync(existingDocPath, 'utf8');
        }
      }
      const record = insertDeliverableSkeleton(projectId, run.id, {
        priority: planned.priority,
        kind: planned.kind,
        format: planned.format,
        title: planned.title,
        targetAssetId: planned.targetAssetId,
        destination: planned.destination,
        audienceAndGoal: planned.audienceAndGoal,
        questionIds: planned.questionIds,
        beforeContent,
      });
      const companionFiles = buildBilingualCompanionFiles(
        projectId,
        planned.destination,
        beforeContent,
        targetLanguage,
      );
      if (companionFiles.length > 0) {
        updateDeliverableRecord(projectId, record.id, { companionFiles });
      }
      return {
        planned,
        record,
      };
    });

    run = transitionOptimizationRun(projectId, run.id, 'drafting', {
      summary: planRes.output.summary,
      statusMessage: `已锁定核心突破口，正在精写旗舰成稿（共 ${createdDeliverables.length} 份）…`,
      recordStep: true,
    });

    for (const { planned, record } of createdDeliverables) {
      const targetQuestions = planned.questionIds
        .map((qid) => questionLookup.get(qid))
        .filter((q): q is { id: string; queryZh: string; queryEn: string } => Boolean(q));

      if (run.status !== 'drafting') {
        run = transitionOptimizationRun(projectId, run.id, 'drafting', {
          statusMessage: `正在撰写「${planned.title}」…`,
          recordStep: true,
        });
      }

      const referenceWinners = await winnerProber(projectId, {
        targetQuestionIds: planned.questionIds,
        targetLanguage,
        maxWinners: 3,
        timeoutMs: 4000,
      }).catch(() => [] as ReferenceWinner[]);
      if (referenceWinners.length > 0) {
        updateDeliverableRecord(projectId, record.id, { referenceWinners });
      }

      let writerRes = await defaultAgentHub.run(
        deliverableWriterAgent,
        {
          deliverable: planned,
          targetQuestions,
          beforeContent: record.beforeContent,
          targetLanguage,
          referenceWinners,
        },
        {
          projectId,
          transport: options.transport,
          preferredProvider,
          onProgress: emitProgress,
          signal: options.signal,
        },
      );

      let finalTitle = writerRes.output.title;
      let finalContent = normalizeDeliverableContent(
        planned.kind,
        planned.format,
        writerRes.output.title,
        writerRes.output.afterContent,
      );
      updateDeliverableRecord(projectId, record.id, {
        title: finalTitle,
        afterContent: finalContent,
        mediaManifest: writerRes.output.mediaManifest,
      });

      // Enter independent 3-red-line review state
      run = transitionOptimizationRun(projectId, run.id, 'reviewing', {
        statusMessage: `正在对「${writerRes.output.title}」执行真实性、合规边界与读者可读性三红线把关…`,
        recordStep: true,
      });

      let reviewRes = await defaultAgentHub.run(
        deliverableReviewerAgent,
        {
          kind: planned.kind,
          format: planned.format,
          title: writerRes.output.title,
          destination: planned.destination,
          audienceAndGoal: planned.audienceAndGoal,
          beforeContent: record.beforeContent,
          afterContent: writerRes.output.afterContent,
          targetLanguage,
        },
        {
          projectId,
          transport: options.transport,
          preferredProvider,
          onProgress: emitProgress,
          signal: options.signal,
        },
      );

      let revisionRound = 0;

      // At most 1 surgical revision round if Reviewer vetoes on a red line
      if (reviewRes.output.verdict === 'veto') {
        revisionRound = 1;
        updateDeliverableRecord(projectId, record.id, {
          review: {
            verdict: 'veto',
            summary: reviewRes.output.summary,
            checks: reviewRes.output.checks,
            revisionRound: 0,
            revisionInstructions: reviewRes.output.revisionInstructions,
            reviewedAt: new Date().toISOString(),
            reviewerModel: reviewRes.model,
          },
        });
        run = transitionOptimizationRun(projectId, run.id, 'drafting', {
          statusMessage: `三红线把关提出修改意见，正在返工精修「${writerRes.output.title}」（第 1/1 次修订）…`,
          recordStep: true,
        });

        writerRes = await defaultAgentHub.run(
          deliverableWriterAgent,
          {
            deliverable: planned,
            targetQuestions,
            beforeContent: record.beforeContent,
            targetLanguage,
            referenceWinners,
            draftToRevise: writerRes.output.afterContent,
            revisionFeedback: reviewRes.output.revisionInstructions,
          },
          {
            projectId,
            transport: options.transport,
            preferredProvider,
            onProgress: emitProgress,
            signal: options.signal,
          },
        );

        finalTitle = writerRes.output.title;
        finalContent = normalizeDeliverableContent(
          planned.kind,
          planned.format,
          writerRes.output.title,
          writerRes.output.afterContent,
        );
        updateDeliverableRecord(projectId, record.id, {
          title: finalTitle,
          afterContent: finalContent,
          mediaManifest: writerRes.output.mediaManifest,
        });

        run = transitionOptimizationRun(projectId, run.id, 'reviewing', {
          statusMessage: `正在对修订后的「${writerRes.output.title}」执行复审把关…`,
          recordStep: true,
        });

        reviewRes = await defaultAgentHub.run(
          deliverableReviewerAgent,
          {
            kind: planned.kind,
            format: planned.format,
            title: writerRes.output.title,
            destination: planned.destination,
            audienceAndGoal: planned.audienceAndGoal,
            beforeContent: record.beforeContent,
            afterContent: writerRes.output.afterContent,
            targetLanguage,
          },
          {
            projectId,
            transport: options.transport,
            preferredProvider,
            onProgress: emitProgress,
            signal: options.signal,
          },
        );
      }

      const finalReview: DeliverableReviewResult = {
        verdict: reviewRes.output.verdict,
        summary: reviewRes.output.summary,
        checks: reviewRes.output.checks,
        revisionRound,
        revisionInstructions: reviewRes.output.revisionInstructions,
        reviewedAt: new Date().toISOString(),
        reviewerModel: reviewRes.model,
      };

      if (finalReview.verdict === 'veto') {
        updateDeliverableRecord(projectId, record.id, { review: finalReview });
        return transitionOptimizationRun(projectId, run.id, 'failed', {
          statusMessage: `成稿未通过三红线把关：${finalReview.summary}`,
          errorMessage: `成稿经修订仍未通过三红线把关：${finalReview.summary}`,
          recordStep: true,
        });
      }

      let updatedCompanions: DeliverableCompanionFile[] | undefined;
      if (targetLanguage === 'en' && options.includeChineseCompanion) {
        emitProgress({
          at: new Date().toISOString(),
          agentId: 'optimization-engine',
          kind: 'start',
          message: `正在为「${finalTitle}」生成地道中文对照版…`,
        });
        updatedCompanions = await generateZhCompanionForDeliverable(
          projectId,
          {
            id: record.id,
            title: finalTitle,
            destination: planned.destination,
            audienceAndGoal: planned.audienceAndGoal,
            afterContent: finalContent,
            beforeContent: record.beforeContent,
            companionFiles: record.companionFiles,
          },
          {
            transport: options.transport,
            preferredProvider,
            onProgress: emitProgress,
            signal: options.signal,
          },
        );
      }

      updateDeliverableRecord(projectId, record.id, {
        status: 'ready',
        review: finalReview,
        ...(updatedCompanions ? { companionFiles: updatedCompanions } : {}),
      });
    }

    if (run.status === 'drafting') {
      run = transitionOptimizationRun(projectId, run.id, 'reviewing', {
        statusMessage: '已完成已有成稿把关核对…',
      });
    }

    return transitionOptimizationRun(projectId, run.id, 'awaiting_approval', {
      statusMessage: '旗舰成稿已通过真实性、合规与可读性三红线把关，等你审阅确认。',
      recordStep: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '优化生成过程中出现异常。';
    return transitionOptimizationRun(projectId, run.id, 'failed', {
      statusMessage: `未能完成：${message}`,
      errorMessage: message,
      recordStep: true,
    });
  }
}

export async function resumeOptimizationRun(
  projectId: string,
  runId: string,
  options: StartOptimizationOptions = {},
): Promise<OptimizationRun> {
  const existing = getOptimizationRun(projectId, runId);
  if (!existing) {
    throw new OptimizationStateError('未找到该优化任务。', 404);
  }
  if (existing.status !== 'failed') {
    throw new OptimizationStateError('只有未能完成的优化任务才能继续重试。');
  }
  if (existing.deliverables.length === 0) {
    return startOptimizationRun(projectId, { ...options, mode: existing.mode });
  }

  const preferredProvider = resolveDefaultPreferredProvider(options.preferredProvider, options.transport);

  let run = transitionOptimizationRun(projectId, runId, 'drafting', {
    statusMessage: '正在基于已有草稿与把关意见继续修订成稿…',
    errorMessage: null,
    recordStep: true,
  });

  const emitProgress = (step: HumanProgressStep) => {
    appendRunProgress(projectId, run.id, step);
    options.onProgress?.(step, run.status);
  };

  try {
    const seed = loadProjectSeed(projectId);
    const targetLanguage =
      seed.project.targetLanguage ??
      resolveProjectTargetLanguage(seed.project, readRelationalOverview(projectId));
    const activeQuestions = withProjectDb(projectId, (db, id) => {
      ensureProjectRelationalData(id, db);
      return db
        .prepare(
          "SELECT id, query_zh AS queryZh, query_en AS queryEn FROM opengeo_questions WHERE project_id = ? AND status = 'active'",
        )
        .all(id) as Array<{ id: string; queryZh: string; queryEn: string }>;
    });
    const questionLookup = new Map(activeQuestions.map((q) => [q.id, q]));

    for (const record of existing.deliverables) {
      if (record.status === 'ready' && record.review?.verdict === 'pass') continue;

      const targetQuestions = record.questionIds
        .map((qid) => questionLookup.get(qid))
        .filter((q): q is { id: string; queryZh: string; queryEn: string } => Boolean(q));

      if (run.status !== 'drafting') {
        run = transitionOptimizationRun(projectId, run.id, 'drafting', {
          statusMessage: `正在继续精修「${record.title}」…`,
          recordStep: true,
        });
      }

      const planned = {
        priority: record.priority,
        kind: record.kind,
        format: record.format,
        title: record.title,
        targetAssetId: record.targetAssetId,
        destination: record.destination,
        audienceAndGoal: record.audienceAndGoal,
        questionIds: record.questionIds,
        writingBrief: record.audienceAndGoal,
      };

      let referenceWinners = record.referenceWinners ?? [];
      if (referenceWinners.length === 0 && options.transport?.provider !== 'test') {
        const winnerProber = options.probeWinners ?? selectAndProbeReferenceWinners;
        referenceWinners = await winnerProber(projectId, {
          targetQuestionIds: record.questionIds,
          targetLanguage,
          maxWinners: 3,
          timeoutMs: 4000,
        }).catch(() => [] as ReferenceWinner[]);
        if (referenceWinners.length > 0) {
          updateDeliverableRecord(projectId, record.id, { referenceWinners });
        }
      }

      const writerRes = await defaultAgentHub.run(
        deliverableWriterAgent,
        {
          deliverable: planned,
          targetQuestions,
          beforeContent: record.beforeContent,
          targetLanguage,
          referenceWinners,
          ...(record.afterContent ? { draftToRevise: record.afterContent } : {}),
          ...(record.review?.revisionInstructions?.length
            ? { revisionFeedback: record.review.revisionInstructions }
            : {}),
        },
        {
          projectId,
          transport: options.transport,
          preferredProvider,
          onProgress: emitProgress,
          signal: options.signal,
        },
      );

      const initialContent = normalizeDeliverableContent(
        planned.kind,
        planned.format,
        writerRes.output.title,
        writerRes.output.afterContent,
      );
      updateDeliverableRecord(projectId, record.id, {
        title: writerRes.output.title,
        afterContent: initialContent,
        mediaManifest: writerRes.output.mediaManifest,
      });

      run = transitionOptimizationRun(projectId, run.id, 'reviewing', {
        statusMessage: `正在对修订后的「${writerRes.output.title}」执行三红线复审…`,
        recordStep: true,
      });

      const reviewRes = await defaultAgentHub.run(
        deliverableReviewerAgent,
        {
          kind: record.kind,
          format: record.format,
          title: writerRes.output.title,
          destination: record.destination,
          audienceAndGoal: record.audienceAndGoal,
          beforeContent: record.beforeContent,
          afterContent: writerRes.output.afterContent,
          targetLanguage,
        },
        {
          projectId,
          transport: options.transport,
          preferredProvider,
          onProgress: emitProgress,
          signal: options.signal,
        },
      );

      const finalReview: DeliverableReviewResult = {
        verdict: reviewRes.output.verdict,
        summary: reviewRes.output.summary,
        checks: reviewRes.output.checks,
        revisionRound: (record.review?.revisionRound ?? 0) + 1,
        revisionInstructions: reviewRes.output.revisionInstructions,
        reviewedAt: new Date().toISOString(),
        reviewerModel: reviewRes.model,
      };

      if (finalReview.verdict === 'veto') {
        updateDeliverableRecord(projectId, record.id, { review: finalReview });
        return transitionOptimizationRun(projectId, run.id, 'failed', {
          statusMessage: `成稿未通过三红线把关：${finalReview.summary}`,
          errorMessage: `成稿经修订仍未通过三红线把关：${finalReview.summary}`,
          recordStep: true,
        });
      }

      let updatedCompanions: DeliverableCompanionFile[] | undefined;
      if (targetLanguage === 'en' && options.includeChineseCompanion) {
        emitProgress({
          at: new Date().toISOString(),
          agentId: 'optimization-engine',
          kind: 'start',
          message: `正在为「${writerRes.output.title}」生成地道中文对照版…`,
        });
        updatedCompanions = await generateZhCompanionForDeliverable(
          projectId,
          {
            id: record.id,
            title: writerRes.output.title,
            destination: record.destination,
            audienceAndGoal: record.audienceAndGoal,
            afterContent: initialContent,
            beforeContent: record.beforeContent,
            companionFiles: record.companionFiles,
          },
          {
            transport: options.transport,
            preferredProvider,
            onProgress: emitProgress,
            signal: options.signal,
          },
        );
      }

      updateDeliverableRecord(projectId, record.id, {
        status: 'ready',
        review: finalReview,
        ...(updatedCompanions ? { companionFiles: updatedCompanions } : {}),
      });
    }

    if (run.status === 'drafting') {
      run = transitionOptimizationRun(projectId, run.id, 'reviewing', {
        statusMessage: '已完成已有成稿把关核对…',
      });
    }

    return transitionOptimizationRun(projectId, run.id, 'awaiting_approval', {
      statusMessage: '旗舰成稿已通过真实性、合规与可读性三红线把关，等你审阅确认。',
      recordStep: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '继续修订过程中出现异常。';
    return transitionOptimizationRun(projectId, run.id, 'failed', {
      statusMessage: `未能完成：${message}`,
      errorMessage: message,
      recordStep: true,
    });
  }
}

export interface DeliverableDecisionInput {
  deliverableId: string;
  action: 'apply' | 'skip';
  writeLocalFile?: boolean;
  publishedUrl?: string;
  note?: string;
}

function resolveSafeNewDocPath(projectId: string, destination: string): string | null {
  const seed = loadProjectSeed(projectId);
  if (!(seed.project.repositoryUrl || '').toLowerCase().includes('github.com/cooleryu/opengeo')) {
    return null;
  }
  const trimmed = destination.trim().replace(/^\/+/, '');
  if (!/^(?:docs|public)\/[a-zA-Z0-9._/-]+\.(?:md|html)$/i.test(trimmed)) return null;
  const root = path.resolve(process.cwd());
  const resolved = path.resolve(root, trimmed);
  if (!resolved.startsWith(`${root}${path.sep}`)) return null;
  return resolved;
}

function resolveSafeLocalRepoDoc(relPath: string): string | null {
  const trimmed = relPath.trim().replace(/^\/+/, '');
  if (!/^(?:README(?:\.[a-zA-Z0-9_-]+)?\.md|(?:docs|public)\/[a-zA-Z0-9._/-]+\.(?:md|html))$/i.test(trimmed)) {
    return null;
  }
  const root = path.resolve(process.cwd());
  const resolved = path.resolve(root, trimmed);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) return null;
  return resolved;
}

function syncCompanionFilesLocally(companionFiles: DeliverableCompanionFile[] | undefined): void {
  if (!companionFiles?.length) return;
  for (const companion of companionFiles) {
    if (companion.reviewOnly) continue;
    const resolved = resolveSafeLocalRepoDoc(companion.path);
    if (!resolved) continue;
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, companion.content, 'utf8');
  }
}

export async function generateDeliverableChineseCompanion(
  projectId: string,
  runId: string,
  deliverableId: string,
  options: {
    transport?: LLMTransport;
    preferredProvider?: 'gemini' | 'deepseek';
  } = {},
): Promise<OptimizationRun> {
  const current = getOptimizationRun(projectId, runId);
  if (!current) throw new OptimizationStateError('没有找到该优化任务。', 404);
  const deliv = current.deliverables.find((d) => d.id === deliverableId);
  if (!deliv) throw new OptimizationStateError('没有找到对应的交付稿件。', 404);
  const preferredProvider = resolveDefaultPreferredProvider(
    options.preferredProvider,
    options.transport,
  );
  const updatedCompanions = await generateZhCompanionForDeliverable(projectId, deliv, {
    transport: options.transport,
    preferredProvider,
  });
  updateDeliverableRecord(projectId, deliv.id, { companionFiles: updatedCompanions });
  return getOptimizationRun(projectId, runId)!;
}

export function applyOptimizationDeliverables(
  projectId: string,
  runId: string,
  decisions: DeliverableDecisionInput[],
): OptimizationRun {
  const current = getOptimizationRun(projectId, runId);
  if (!current) throw new OptimizationStateError('没有找到该优化任务。', 404);
  if (!['awaiting_approval', 'implementing', 'awaiting_retest', 'completed'].includes(current.status)) {
    throw new OptimizationStateError('当前任务状态尚不可执行确认落地操作。', 409);
  }
  if (!decisions.length) throw new OptimizationStateError('请至少选择一项交付稿的处理方式。', 400);

  transitionOptimizationRun(projectId, runId, 'implementing', {
    statusMessage: '正在按你的确认执行内容落地与记录登记…',
    recordStep: true,
  });

  const delivMap = new Map(current.deliverables.map((d) => [d.id, d]));

  for (const decision of decisions) {
    const deliv = delivMap.get(decision.deliverableId);
    if (!deliv) throw new OptimizationStateError(`未找到交付稿（${decision.deliverableId}）。`, 404);

    if (decision.action === 'skip') {
      updateDeliverableRecord(projectId, deliv.id, { status: 'skipped', appliedRecord: null });
      continue;
    }

    const now = new Date().toISOString();
    if (deliv.kind === 'update_asset') {
      if (!deliv.targetAssetId) throw new OptimizationStateError('该改稿缺少关联的自有资料标识。', 400);
      const owned = resolveOwnedAssetContent(projectId, deliv.targetAssetId);
      if (!owned.found || !owned.asset) {
        throw new OptimizationStateError(owned.message || '目标材料不属于可修改的自有资料。', 403);
      }
      let mode: 'local_file' | 'external_published' = 'external_published';
      let writtenDestination = deliv.destination || owned.asset.publicUrl || owned.asset.title;

      if (decision.writeLocalFile !== false && owned.localRepoPath) {
        fs.mkdirSync(path.dirname(owned.localRepoPath), { recursive: true });
        fs.writeFileSync(owned.localRepoPath, deliv.afterContent, 'utf8');
        syncCompanionFilesLocally(deliv.companionFiles);
        mode = 'local_file';
        writtenDestination = path.relative(process.cwd(), owned.localRepoPath);
      }

      updateDeliverableRecord(projectId, deliv.id, {
        status: 'applied',
        appliedRecord: {
          appliedAt: now,
          mode,
          destination: writtenDestination,
          ...(decision.publishedUrl ? { publishedUrl: decision.publishedUrl } : {}),
          ...(decision.note ? { note: decision.note } : {}),
        },
      });
    } else {
      const localDocPath = decision.writeLocalFile ? resolveSafeNewDocPath(projectId, deliv.destination) : null;
      if (localDocPath) {
        fs.mkdirSync(path.dirname(localDocPath), { recursive: true });
        fs.writeFileSync(localDocPath, deliv.afterContent, 'utf8');
        syncCompanionFilesLocally(deliv.companionFiles);
        updateDeliverableRecord(projectId, deliv.id, {
          status: 'applied',
          appliedRecord: {
            appliedAt: now,
            mode: 'local_file',
            destination: path.relative(process.cwd(), localDocPath),
            ...(decision.publishedUrl ? { publishedUrl: decision.publishedUrl } : {}),
            ...(decision.note ? { note: decision.note } : {}),
          },
        });
      } else {
        updateDeliverableRecord(projectId, deliv.id, {
          status: 'applied',
          appliedRecord: {
            appliedAt: now,
            mode: 'external_published',
            destination: deliv.destination,
            ...(decision.publishedUrl ? { publishedUrl: decision.publishedUrl } : {}),
            ...(decision.note ? { note: decision.note } : {}),
          },
        });
      }
    }
  }

  const refreshed = getOptimizationRun(projectId, runId)!;
  const anyPending = refreshed.deliverables.some((d) => d.status === 'ready' || d.status === 'drafting');
  const anyApplied = refreshed.deliverables.some((d) => d.status === 'applied');

  if (anyPending || !anyApplied) {
    return transitionOptimizationRun(projectId, runId, 'awaiting_approval', {
      statusMessage: anyApplied ? '部分成稿已落地，其余成稿等你确认。' : '尚未应用任何成稿，可随时重新确认落地。',
    });
  }

  return transitionOptimizationRun(projectId, runId, 'awaiting_retest', {
    statusMessage: '成稿已确认落地，随时可按原问题与同条件发起复测，检验真实曝光变化。',
    recordStep: true,
  });
}

export interface CapturedRetestAnswer {
  questionId: string;
  engine: ResearchEngine;
  language?: 'zh' | 'en';
  query?: string;
  answerText: string;
  citations?: Array<{ title: string; url: string }>;
  citationSource?: 'native' | 'unknown' | 'none';
  citationsComplete?: boolean;
}

export interface RunOptimizationRetestOptions {
  capturedAnswers?: CapturedRetestAnswer[];
  liveProvider?: 'qwen' | 'doubao';
  transport?: LLMTransport;
  preferredProvider?: 'gemini' | 'deepseek';
}

export async function runOptimizationRetest(
  projectId: string,
  runId: string,
  options: RunOptimizationRetestOptions = {},
): Promise<OptimizationRun> {
  const current = getOptimizationRun(projectId, runId);
  if (!current) throw new OptimizationStateError('没有找到该优化任务。', 404);
  const hasApplied = current.deliverables.some((d) => d.status === 'applied');
  if (
    !['awaiting_retest', 'completed'].includes(current.status) &&
    !(current.status === 'awaiting_approval' && hasApplied)
  ) {
    throw new OptimizationStateError('请先确认成稿落地后，再发起原题复测。', 409);
  }

  transitionOptimizationRun(projectId, runId, 'remeasuring', {
    statusMessage: '正在按原问题执行同条件复测，并进行排除个人记忆污染的语义判卷…',
    recordStep: true,
  });

  try {
    const questionRows = withProjectDb(projectId, (db, id) => {
      ensureProjectRelationalData(id, db);
      return db
        .prepare(
          "SELECT id, query_zh AS queryZh, query_en AS queryEn FROM opengeo_questions WHERE project_id = ? AND status = 'active'",
        )
        .all(id) as Array<{ id: string; queryZh: string; queryEn: string }>;
    });
    const questionMap = new Map(questionRows.map((q) => [q.id, q]));

    const targetQuestionIds = [
      ...new Set(
        current.deliverables
          .filter((d) => d.status === 'applied')
          .flatMap((d) => d.questionIds),
      ),
    ];

    const answersToIngest: Array<{
      questionId: string;
      engine: ResearchEngine;
      language: 'zh' | 'en';
      query: string;
      collected: CollectedAnswer;
    }> = [];

    if (options.capturedAnswers?.length) {
      for (const item of options.capturedAnswers) {
        const q = questionMap.get(item.questionId);
        if (!q) throw new OptimizationStateError(`复测问题（${item.questionId}）不在当前核心问题中。`, 400);
        const lang = item.language ?? 'zh';
        const query = item.query || (lang === 'en' && q.queryEn ? q.queryEn : q.queryZh);
        answersToIngest.push({
          questionId: item.questionId,
          engine: item.engine,
          language: lang,
          query,
          collected: {
            text: item.answerText,
            citations: item.citations ?? [],
            sources: (item.citations ?? []).map((c) => ({ title: c.title, url: c.url })),
            searchPerformed: true,
            usage: {},
            evidence: {
              answerComplete: true,
              citationsComplete: item.citationsComplete ?? false,
              citationSource: item.citationSource ?? 'unknown',
            },
          },
        });
      }
    } else if (options.liveProvider) {
      const provider = options.liveProvider;
      const apiKey = requireCollectionKey(provider);
      const config = getCollectionConfig(provider);
      const qids = targetQuestionIds.length ? targetQuestionIds : questionRows.slice(0, 2).map((q) => q.id);

      for (const qid of qids) {
        const q = questionMap.get(qid);
        if (!q) continue;
        const query = q.queryZh || q.queryEn;
        const req =
          provider === 'qwen'
            ? buildQwenRequest(query, config, apiKey)
            : buildDoubaoRequest(query, config, apiKey);
        const resp = await fetch(req.url, {
          method: 'POST',
          headers: req.headers,
          body: JSON.stringify(req.body),
        });
        const rawJson = await resp.json();
        const parsed = provider === 'qwen' ? parseQwenAnswer(rawJson) : parseDoubaoAnswer(rawJson);
        answersToIngest.push({
          questionId: qid,
          engine: provider,
          language: 'zh',
          query,
          collected: parsed,
        });
      }
    } else {
      throw new OptimizationStateError('请选择联网复测平台（如千问/豆包）或提交最新采集的真实搜索回答。', 400);
    }

    const seed = loadProjectSeed(projectId);
    const dataDir = withGeoProject(projectId, projectDataDirectory);
    const retestRelDir = `geo-evidence/retest-${runId}`;
    const retestAbsDir = path.join(dataDir, retestRelDir);
    fs.mkdirSync(retestAbsDir, { recursive: true });

    const newFollowupIds = [...current.followupObservationIds];

    for (const item of answersToIngest) {
      const obsId = `retest-${randomUUID().slice(0, 12)}`;
      const now = new Date().toISOString();
      const answerFileRel = `data/${retestRelDir}/${obsId}.md`;
      const evidenceFileRel = `data/${retestRelDir}/${obsId}.json`;

      fs.writeFileSync(path.join(retestAbsDir, `${obsId}.md`), item.collected.text, 'utf8');
      fs.writeFileSync(
        path.join(retestAbsDir, `${obsId}.json`),
        JSON.stringify(
          {
            id: obsId,
            optimizationRunId: runId,
            questionId: item.questionId,
            engine: item.engine,
            language: item.language,
            query: item.query,
            recordedAt: now,
            answer_text: item.collected.text,
            citations: item.collected.citations,
            evidence: item.collected.evidence,
          },
          null,
          2,
        ),
        'utf8',
      );

      const observation: ResearchObservation = {
        id: obsId,
        engine: item.engine,
        language: item.language,
        entryType: item.engine === 'chatgpt' || item.engine === 'google' ? 'web_answer' : 'api_answer',
        query: item.query,
        recordedAt: now,
        collectedAt: now,
        status: 'not_observed',
        summary: item.collected.text.slice(0, 180),
        conditions: `优化任务 ${runId} 同题复测`,
        sources: item.collected.citations.map((c) => ({
          title: c.title,
          url: c.url,
          kind: isProjectOwnedUrl(c.url, seed.project) ? 'official' : 'other',
        })),
        evidencePath: evidenceFileRel,
        answerPath: answerFileRel,
      };

      const ingested = await ingestRelationalObservation(
        {
          projectId,
          questionId: item.questionId,
          observation,
          answer: item.collected,
          optimizationRunId: runId,
        },
        {
          auditor: async ({ observation: obs, answer }) => {
            const auditRes = await defaultAgentHub.run(
              answerAuditorAgent,
              {
                query: obs.query,
                answerText: answer?.text ?? '',
                citationSource: answer?.evidence?.citationSource ?? 'unknown',
                citationsComplete: answer?.evidence?.citationsComplete ?? false,
                nativeCitations: (answer?.citations ?? []).map((c) => ({ title: c.title, url: c.url })),
              },
              {
                projectId,
                transport: options.transport,
                preferredProvider: resolveDefaultPreferredProvider(
                  options.preferredProvider,
                  options.transport,
                ),
              },
            );
            const out = auditRes.output;
            return {
              mention: out.mention,
              citation: out.citation,
              mentionEvidence: out.mentionQuote
                ? `${out.mentionEvidence}\n原文：${out.mentionQuote}`
                : out.mentionEvidence,
              citationEvidence: out.citationEvidence,
              officialUrls: out.officialUrls,
              answerComplete: true,
              analysisStatus:
                out.mention !== 'unknown' && out.citation !== 'unknown' ? 'complete' : 'needs_review',
              method: 'model',
              analysisModel: auditRes.model,
              reviewedAt: new Date().toISOString(),
            };
          },
        },
      );

      // Update observation status ('found' vs 'not_observed') to match semantic mention/citation
      if (ingested.audit.mention === 'yes' || ingested.audit.citation === 'yes') {
        withProjectDb(projectId, (db, id) => {
          db.prepare("UPDATE opengeo_observations SET status = 'found' WHERE project_id = ? AND id = ?").run(
            id,
            ingested.observationId,
          );
        });
      }

      newFollowupIds.push(ingested.observationId);
    }

    return transitionOptimizationRun(projectId, runId, 'completed', {
      followupObservationIds: newFollowupIds,
      statusMessage: `已完成 ${answersToIngest.length} 条原题同条件复测与语义判卷，前后曝光对比已就绪。`,
      recordStep: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '复测执行异常。';
    transitionOptimizationRun(projectId, runId, 'awaiting_retest', {
      statusMessage: `复测未完成（${message}），已保留原落地状态，可稍后重试。`,
      recordStep: true,
    });
    throw error;
  }
}

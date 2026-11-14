import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AgentTool } from '../../agent-hub';
import { resolveAssetOwnership } from '../asset-ownership';
import { ensureProjectRelationalData, parseSourcesJson, withProjectDb } from '../db';
import { loadProjectSeed } from '../project-data';
import { evidenceLocation, withGeoProject } from '../projects';
import type { GeoAsset, GeoSeed } from '../types';

function readAnswerTextFromFile(fullPath: string): string {
  const raw = fs.readFileSync(fullPath, 'utf8');
  if (!fullPath.endsWith('.json')) return raw;
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (typeof parsed.answer_text === 'string') return parsed.answer_text;
  if (parsed.input && typeof (parsed.input as { answerText?: unknown }).answerText === 'string') {
    return (parsed.input as { answerText: string }).answerText;
  }
  if (parsed.answer && typeof (parsed.answer as { text?: unknown }).text === 'string') {
    return (parsed.answer as { text: string }).text;
  }
  return raw;
}

function isSelfWorkspaceRepo(seed: GeoSeed): boolean {
  const repoUrl = (seed.project.repositoryUrl || '').toLowerCase();
  return repoUrl.includes('github.com/cooleryu/opengeo');
}

/** Maps a GitHub blob URL of the current workspace repo to its safe local file path, if inside cwd. */
export function resolveLocalRepoFileForAsset(projectId: string, asset: GeoAsset): string | null {
  const seed = loadProjectSeed(projectId);
  if (!isSelfWorkspaceRepo(seed) || !asset.publicUrl) return null;
  const match = asset.publicUrl.match(/^https?:\/\/github\.com\/cooleryu\/opengeo\/blob\/[^/]+\/(.+)$/i);
  if (!match) return null;
  const relPath = decodeURIComponent(match[1]);
  const root = path.resolve(process.cwd());
  const resolved = path.resolve(root, relPath);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) return null;
  return resolved;
}

export function resolveOwnedAssetContent(
  projectId: string,
  assetId: string,
): { found: boolean; asset?: GeoAsset; localRepoPath?: string | null; markdown?: string; message?: string } {
  const seed = loadProjectSeed(projectId);
  const owned = seed.assets.filter((a) => resolveAssetOwnership(a, seed).ownership === 'owned');
  const target = owned.find((a) => a.id === assetId);
  if (!target) return { found: false, message: '未找到该自有资料或该资料属于外部参考。' };

  const localRepoPath = resolveLocalRepoFileForAsset(projectId, target);
  if (localRepoPath && fs.existsSync(localRepoPath)) {
    return {
      found: true,
      asset: target,
      localRepoPath,
      markdown: fs.readFileSync(localRepoPath, 'utf8'),
    };
  }

  const snapshotPath = target.sourcePath
    ? withGeoProject(projectId, () => evidenceLocation(target.sourcePath).target)
    : '';
  const markdown =
    snapshotPath && fs.existsSync(snapshotPath) ? fs.readFileSync(snapshotPath, 'utf8') : target.markdown;
  return { found: true, asset: target, localRepoPath: null, markdown };
}

export interface ProjectMediaItem {
  embedPath: string;
  diskPath: string;
  bytes: number;
  captionHint: string;
  screenshotLanguage?: 'zh' | 'en';
}

const KNOWN_MEDIA_META: Record<string, { captionHint: string; screenshotLanguage: 'zh' | 'en' }> = {
  'docs/images/overview.png': {
    captionHint: 'OpenGEO 概览页界面截图（中文界面）：AI 回答提及率、官网链接引用与各平台对比一览',
    screenshotLanguage: 'zh',
  },
  'docs/images/overview-en.png': {
    captionHint: 'OpenGEO Overview dashboard (English UI): Track brand mention rate, official link citations, and competitor comparisons across ChatGPT and Google.',
    screenshotLanguage: 'en',
  },
  'docs/images/question-answer.png': {
    captionHint: 'OpenGEO 回答详情页界面截图（中文界面）：逐题对比原始提问、AI 回答正文、引文与竞品提及',
    screenshotLanguage: 'zh',
  },
  'docs/images/question-answer-en.png': {
    captionHint: 'OpenGEO Question Detail view (English UI): Inspect verbatim AI answers, inline citations, and competitor mentions per question.',
    screenshotLanguage: 'en',
  },
  'docs/images/improvement-tracking.png': {
    captionHint: 'OpenGEO 改进工作台界面截图（中文界面）：对照短板生成三份优化稿与中英对照预览，采纳后再复查前后变化',
    screenshotLanguage: 'zh',
  },
  'docs/images/improvement-tracking-en.png': {
    captionHint: 'OpenGEO Optimization Studio (English UI): Compare drafts, inspect evidence, publish updates, and re-audit the same prompts over time.',
    screenshotLanguage: 'en',
  },
};

export function listAvailableProjectMedia(
  projectId: string,
  options?: { targetLanguage?: 'en' | 'zh' },
): ProjectMediaItem[] {
  const seed = loadProjectSeed(projectId);
  const items: ProjectMediaItem[] = [];
  if (!isSelfWorkspaceRepo(seed)) return items;

  const root = path.resolve(process.cwd());
  const scanDirs: Array<{ dir: string; toEmbed: (relFromDir: string) => string }> = [
    { dir: path.join(root, 'docs', 'images'), toEmbed: (f) => `docs/images/${f}` },
  ];

  const walk = (baseDir: string, sub = ''): string[] => {
    const full = path.join(baseDir, sub);
    if (!fs.existsSync(full)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...walk(baseDir, rel));
      else if (/\.(png|jpe?g|webp|svg)$/i.test(entry.name)) out.push(rel);
    }
    return out;
  };

  for (const { dir, toEmbed } of scanDirs) {
    for (const rel of walk(dir)) {
      const diskPath = path.join(dir, rel);
      const embedPath = toEmbed(rel);
      const meta = KNOWN_MEDIA_META[embedPath];
      const item: ProjectMediaItem = {
        embedPath,
        diskPath,
        bytes: fs.statSync(diskPath).size,
        captionHint: meta?.captionHint ?? `项目真实配图（${path.basename(embedPath)}）`,
        screenshotLanguage: meta?.screenshotLanguage,
      };
      if (options?.targetLanguage === 'en' && item.screenshotLanguage === 'zh') {
        continue;
      }
      if (options?.targetLanguage === 'zh' && item.screenshotLanguage === 'en') {
        continue;
      }
      items.push(item);
    }
  }
  return items;
}

export function formatMediaPathForDestination(
  item: ProjectMediaItem,
  destination?: string,
): string {
  if (!destination) return item.embedPath;
  const trimmed = destination.trim();
  if (!trimmed || /^https?:\/\//i.test(trimmed) || !/\.(md|mdx|html?)$/i.test(trimmed)) {
    return item.embedPath;
  }
  const root = path.resolve(process.cwd());
  const destAbs = path.resolve(root, trimmed.replace(/^\/+/, ''));
  if (!destAbs.startsWith(`${root}${path.sep}`)) return item.embedPath;
  const rel = path.relative(path.dirname(destAbs), item.diskPath).split(path.sep).join('/');
  return rel || item.embedPath;
}

export function localMediaPathExists(
  projectId: string,
  refPath: string,
  destination?: string,
): boolean {
  const clean = refPath.trim().split(/[?#]/)[0];
  if (!clean || /^https?:\/\//i.test(clean) || clean.startsWith('data:')) return true;
  const available = listAvailableProjectMedia(projectId);
  if (
    available.some(
      (m) =>
        m.embedPath === clean ||
        `public${m.embedPath}` === clean ||
        formatMediaPathForDestination(m, destination) === clean,
    )
  ) {
    return true;
  }
  const root = path.resolve(process.cwd());
  const candidates: string[] = [
    clean.startsWith('/') ? path.join(root, 'public', clean.slice(1)) : path.resolve(root, clean),
  ];
  if (destination && !/^https?:\/\//i.test(destination.trim())) {
    const destAbs = path.resolve(root, destination.trim().replace(/^\/+/, ''));
    if (destAbs.startsWith(`${root}${path.sep}`)) {
      candidates.push(path.resolve(path.dirname(destAbs), clean));
    }
  }
  return candidates.some(
    (c) => c.startsWith(`${root}${path.sep}`) && fs.existsSync(c) && fs.statSync(c).isFile(),
  );
}

/** Provides read-only autonomous inspection tools scoped strictly to `projectId`. */
export function createProjectInspectionTools(options?: {
  targetLanguage?: 'en' | 'zh';
}): AgentTool<any>[] {
  const listQuestionsTool: AgentTool<Record<string, never>> = {
    name: 'list_project_questions',
    description: '列出当前项目所有核心监测问题，以及各搜索平台的最新提及与引用结论。',
    parameters: z.object({}),
    readOnly: true,
    humanLabel: () => '正在查看项目的核心监测问题与各平台曝光现状…',
    execute: (_args, ctx) =>
      withProjectDb(ctx.projectId, (db, projectId) => {
        ensureProjectRelationalData(projectId, db);
        const questions = db
          .prepare(
            `SELECT id, category, query_zh, query_en
             FROM opengeo_questions
             WHERE project_id = ? AND status = 'active'
             ORDER BY sort_order ASC`,
          )
          .all(projectId) as Array<{
          id: string;
          category: string | null;
          query_zh: string;
          query_en: string;
        }>;

        return questions.map((q) => {
          const filteredObs = options?.targetLanguage
            ? db
                .prepare(
                  `SELECT o.id, o.engine, o.entry_type, o.recorded_at, a.mention, a.citation, a.mention_evidence
                   FROM opengeo_observations o
                   LEFT JOIN opengeo_answer_audits a
                     ON a.project_id = o.project_id AND a.observation_id = o.id AND a.is_current = 1
                   WHERE o.project_id = ? AND o.question_id = ? AND o.language = ?
                   ORDER BY o.seq DESC`,
                )
                .all(projectId, q.id, options.targetLanguage)
            : [];
          const latestObs =
            filteredObs.length > 0
              ? filteredObs
              : db
                  .prepare(
                    `SELECT o.id, o.engine, o.entry_type, o.recorded_at, a.mention, a.citation, a.mention_evidence
                     FROM opengeo_observations o
                     LEFT JOIN opengeo_answer_audits a
                       ON a.project_id = o.project_id AND a.observation_id = o.id AND a.is_current = 1
                     WHERE o.project_id = ? AND o.question_id = ?
                     ORDER BY o.seq DESC`,
                  )
                  .all(projectId, q.id);
          return {
            questionId: q.id,
            category: q.category ?? 'problem',
            queryZh: q.query_zh,
            queryEn: q.query_en,
            observations: latestObs,
          };
        });
      }),
  };

  const readObservationTool: AgentTool<{
    questionId: string;
    engine: 'chatgpt' | 'google' | 'deepseek' | 'qwen' | 'doubao';
  }> = {
    name: 'read_observation_answer',
    description: '按问题编号与平台（如 chatgpt、google）读取本地保存的完整 AI 搜索回答原文及引用来源。',
    parameters: z.object({
      questionId: z.string().min(1),
      engine: z.enum(['chatgpt', 'google', 'deepseek', 'qwen', 'doubao']),
    }),
    readOnly: true,
    humanLabel: (args) => `正在调阅问题在 ${args.engine} 上的真实搜索回答原文…`,
    execute: (args, ctx) =>
      withProjectDb(ctx.projectId, (db, projectId) => {
        ensureProjectRelationalData(projectId, db);
        type ObsRow = {
          id: string;
          query_text: string;
          engine: string;
          entry_type: string | null;
          answer_path: string | null;
          evidence_path: string;
          sources_json: string;
          conditions_text: string;
          recorded_at: string;
        };
        const filteredRow = options?.targetLanguage
          ? (db
              .prepare(
                `SELECT id, query_text, engine, entry_type, answer_path, evidence_path, sources_json, conditions_text, recorded_at
                 FROM opengeo_observations
                 WHERE project_id = ? AND question_id = ? AND engine = ? AND language = ?
                 ORDER BY seq DESC LIMIT 1`,
              )
              .get(projectId, args.questionId, args.engine, options.targetLanguage) as
              | ObsRow
              | undefined)
          : undefined;
        const row =
          filteredRow ??
          (db
            .prepare(
              `SELECT id, query_text, engine, entry_type, answer_path, evidence_path, sources_json, conditions_text, recorded_at
               FROM opengeo_observations
               WHERE project_id = ? AND question_id = ? AND engine = ?
               ORDER BY seq DESC LIMIT 1`,
            )
            .get(projectId, args.questionId, args.engine) as ObsRow | undefined);
        if (!row) return { found: false, message: '尚未采集该问题在此平台的回答。' };
        const relPath = row.answer_path ?? row.evidence_path;
        const fullPath = withGeoProject(projectId, () => evidenceLocation(relPath).target);
        const answerText = fs.existsSync(fullPath) ? readAnswerTextFromFile(fullPath) : '';
        return {
          found: true,
          observationId: row.id,
          query: row.query_text,
          recordedAt: row.recorded_at,
          entryType: row.entry_type,
          conditions: row.conditions_text,
          sources: parseSourcesJson(row.sources_json),
          answerText: answerText.slice(0, 16_000),
        };
      }),
  };

  const readOwnedAssetTool: AgentTool<{ assetId?: string }> = {
    name: 'read_owned_asset',
    description: '读取项目已登记的自有文档（不传 assetId 时返回自有资料清单；传入 assetId 返回最新完整原文）。',
    parameters: z.object({ assetId: z.string().optional() }),
    readOnly: true,
    humanLabel: (args) =>
      args.assetId ? '正在完整阅读项目现有自有文档…' : '正在盘点项目现有的自有资料清单…',
    execute: (args, ctx) => {
      const seed = loadProjectSeed(ctx.projectId);
      const owned = seed.assets.filter((a) => resolveAssetOwnership(a, seed).ownership === 'owned');
      if (!args.assetId) {
        return owned.map((a) => ({
          assetId: a.id,
          title: a.title,
          type: a.type,
          publicUrl: a.publicUrl,
          summary: a.summary,
        }));
      }
      const res = resolveOwnedAssetContent(ctx.projectId, args.assetId);
      if (!res.found || !res.asset) return { found: false, message: res.message };
      return {
        found: true,
        assetId: res.asset.id,
        title: res.asset.title,
        publicUrl: res.asset.publicUrl,
        markdown: res.markdown,
      };
    },
  };

  const listMediaTool: AgentTool<Record<string, never>> = {
    name: 'list_project_media',
    description: '列出项目内真实存在的界面截图与实测配图清单，供成稿直接引用（严禁臆造清单之外的图片路径）。',
    parameters: z.object({}),
    readOnly: true,
    humanLabel: () => '正在核对项目可用的真实界面截图与实测配图…',
    execute: (_args, ctx) =>
      listAvailableProjectMedia(ctx.projectId, { targetLanguage: options?.targetLanguage }).map((m) => ({
        embedPath: m.embedPath,
        bytes: m.bytes,
        captionHint: m.captionHint,
      })),
  };

  return [listQuestionsTool, readObservationTool, readOwnedAssetTool, listMediaTool];
}

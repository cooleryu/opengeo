import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AgentTool } from '../../agent-hub';
import { isProjectOwnedUrl, resolveAssetOwnership } from '../asset-ownership';
import { ensureProjectRelationalData, parseSourcesJson, withProjectDb } from '../db';
import {
  classifyCitedChannel,
  loadQuestionPlanSignalsMap,
  lookupQuestionPlanMeta,
  normalizeUrlMeta,
  parseRecommendedBrands,
} from '../optimization/citation-classifier';
import { readProjectContext } from '../project-context';
import { loadProjectSeed } from '../project-data';
import { evidenceLocation, withGeoProject } from '../projects';
import { parseGitHubRepoUrl } from '../source-identity';
import type { GeoAsset, GeoSeed } from '../types';

export function readAnswerTextFromFile(fullPath: string): string {
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

let cachedWorkspaceRepoSlug: { owner: string; repo: string } | null | undefined;

/** Parses GitHub owner/repo from the workspace's git `origin` remote once per process. */
export function resolveWorkspaceRepoSlug(): { owner: string; repo: string } | null {
  if (cachedWorkspaceRepoSlug !== undefined) return cachedWorkspaceRepoSlug;
  try {
    const rawRemote = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trim();
    const sshMatch = rawRemote.match(
      /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i,
    );
    if (sshMatch) {
      cachedWorkspaceRepoSlug = { owner: sshMatch[1], repo: sshMatch[2] };
      return cachedWorkspaceRepoSlug;
    }
    const parsed = parseGitHubRepoUrl(rawRemote, { allowSubpaths: true });
    cachedWorkspaceRepoSlug = parsed ? { owner: parsed.owner, repo: parsed.repo } : null;
  } catch {
    cachedWorkspaceRepoSlug = null;
  }
  return cachedWorkspaceRepoSlug;
}

export function isSelfWorkspaceRepo(seed: GeoSeed): boolean {
  const workspaceSlug = resolveWorkspaceRepoSlug();
  if (!workspaceSlug) return false;
  const projectSlug = parseGitHubRepoUrl(seed.project.repositoryUrl ?? '', { allowSubpaths: true });
  if (!projectSlug) return false;
  return (
    projectSlug.owner.toLowerCase() === workspaceSlug.owner.toLowerCase() &&
    projectSlug.repo.toLowerCase() === workspaceSlug.repo.toLowerCase()
  );
}

/** Maps a GitHub blob URL of the current workspace repo to its safe local file path, if inside cwd. */
export function resolveLocalRepoFileForAsset(projectId: string, asset: GeoAsset): string | null {
  const seed = loadProjectSeed(projectId);
  if (!isSelfWorkspaceRepo(seed) || !asset.publicUrl) return null;
  const workspaceSlug = resolveWorkspaceRepoSlug();
  if (!workspaceSlug) return null;
  const match = asset.publicUrl.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/[^/]+\/(.+)$/i,
  );
  if (!match) return null;
  const [, urlOwner, urlRepo, rawPath] = match;
  if (
    urlOwner.toLowerCase() !== workspaceSlug.owner.toLowerCase() ||
    urlRepo.toLowerCase() !== workspaceSlug.repo.toLowerCase()
  ) {
    return null;
  }
  const relPath = decodeURIComponent(rawPath);
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

function inferMediaLanguageAndCaption(
  projectName: string,
  embedPath: string,
  allEmbedPaths: Set<string>,
): { screenshotLanguage?: 'zh' | 'en'; captionHint: string } {
  const baseName = path.basename(embedPath);
  if (/-en\.(png|jpe?g|webp|svg)$/i.test(embedPath)) {
    return {
      screenshotLanguage: 'en',
      captionHint: `${projectName} English UI screenshot (${baseName})`,
    };
  }
  if (/-zh(?:-cn)?\.(png|jpe?g|webp|svg)$/i.test(embedPath)) {
    return {
      screenshotLanguage: 'zh',
      captionHint: `${projectName} 中文界面截图（${baseName}）`,
    };
  }
  const extMatch = embedPath.match(/(\.[^.]+)$/);
  if (extMatch) {
    const enSibling = `${embedPath.slice(0, -extMatch[1].length)}-en${extMatch[1]}`;
    if (allEmbedPaths.has(enSibling)) {
      return {
        screenshotLanguage: 'zh',
        captionHint: `${projectName} 界面截图（${baseName}）`,
      };
    }
  }
  return {
    captionHint: `${projectName} media asset (${baseName})`,
  };
}

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
    const relFiles = walk(dir);
    const allEmbedPaths = new Set(relFiles.map((rel) => toEmbed(rel)));
    for (const rel of relFiles) {
      const diskPath = path.join(dir, rel);
      const embedPath = toEmbed(rel);
      const inferred = inferMediaLanguageAndCaption(seed.project.name, embedPath, allEmbedPaths);
      const item: ProjectMediaItem = {
        embedPath,
        diskPath,
        bytes: fs.statSync(diskPath).size,
        captionHint: inferred.captionHint,
        screenshotLanguage: inferred.screenshotLanguage,
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

const ALLOWED_WORKSPACE_FILE_RE =
  /^(?:package\.json|license(?:[.-][a-z0-9._-]+)?|readme(?:[.-][a-z0-9._-]+)?|(?:docs|src)\/.+)$/i;

const BLOCKED_WORKSPACE_SEGMENT_RE =
  /(?:^|\/)(?:\.env(?:\.|$)|\.git(?:\/|$)|node_modules(?:\/|$)|\.next(?:\/|$)|data(?:\/|$))/i;

const BLOCKED_WORKSPACE_EXT_RE =
  /\.(?:pem|key|p12|pfx|crt|sqlite|sqlite3|db|png|jpe?g|webp|ico|woff2?|pdf|zip|tar|gz)$/i;

/**
 * Strict allowlist for AI read-only source inspection so local secrets
 * (such as data/geo-settings.json or data/chatgpt-private/connection.json)
 * can never be read or sent to a model provider.
 */
export function isAllowedWorkspaceInspectionPath(relativePath: string): boolean {
  const normalized = relativePath.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) return false;
  const segments = normalized.split('/');
  if (segments.some((seg) => !seg || seg === '.' || seg === '..' || seg.startsWith('.'))) {
    return false;
  }
  if (BLOCKED_WORKSPACE_SEGMENT_RE.test(normalized)) return false;
  if (BLOCKED_WORKSPACE_EXT_RE.test(normalized)) return false;
  return ALLOWED_WORKSPACE_FILE_RE.test(normalized);
}

/** Provides read-only autonomous inspection tools scoped strictly to `projectId`. */
export function createProjectInspectionTools(options?: {
  targetLanguage?: 'en' | 'zh';
}): AgentTool<any>[] {
  const listQuestionsTool: AgentTool<Record<string, never>> = {
    name: 'list_project_questions',
    description:
      '列出当前项目所有核心监测问题，以及各搜索平台的最新提及/引用结论、被引用外部来源渠道和关联子问题。',
    parameters: z.object({}),
    readOnly: true,
    humanLabel: () => '正在查看项目的核心监测问题、引用渠道与各平台曝光现状…',
    execute: (_args, ctx) => {
      const planMaps = loadQuestionPlanSignalsMap(ctx.projectId);
      const seed = loadProjectSeed(ctx.projectId);
      return withProjectDb(ctx.projectId, (db, projectId) => {
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

        type ObsSummaryRow = {
          id: string;
          engine: string;
          entry_type: string | null;
          recorded_at: string;
          sources_json: string;
          mention: string | null;
          citation: string | null;
          mention_evidence: string | null;
          recommended_competitors_json: string | null;
        };

        return questions.map((q) => {
          const filteredObs = options?.targetLanguage
            ? (db
                .prepare(
                  `SELECT o.id, o.engine, o.entry_type, o.recorded_at, o.sources_json, a.mention, a.citation, a.mention_evidence, a.recommended_competitors_json
                   FROM opengeo_observations o
                   LEFT JOIN opengeo_answer_audits a
                     ON a.project_id = o.project_id AND a.observation_id = o.id AND a.is_current = 1
                   WHERE o.project_id = ? AND o.question_id = ? AND o.language = ? AND o.engine IN ('chatgpt', 'google')
                   ORDER BY o.seq DESC`,
                )
                .all(projectId, q.id, options.targetLanguage) as ObsSummaryRow[])
            : [];
          const allObs =
            filteredObs.length > 0
              ? filteredObs
              : (db
                  .prepare(
                    `SELECT o.id, o.engine, o.entry_type, o.recorded_at, o.sources_json, a.mention, a.citation, a.mention_evidence, a.recommended_competitors_json
                     FROM opengeo_observations o
                     LEFT JOIN opengeo_answer_audits a
                       ON a.project_id = o.project_id AND a.observation_id = o.id AND a.is_current = 1
                     WHERE o.project_id = ? AND o.question_id = ? AND o.engine IN ('chatgpt', 'google')
                     ORDER BY o.seq DESC`,
                  )
                  .all(projectId, q.id) as ObsSummaryRow[]);
          // Deduplicate to latest observation per engine so stale history does not drown current signals.
          const seenEngines = new Set<string>();
          const latestObs = allObs
            .filter((row) => {
              if (seenEngines.has(row.engine)) return false;
              seenEngines.add(row.engine);
              return true;
            })
            .map((row) => {
              const citedSources = parseSourcesJson(row.sources_json)
                .map((src) => {
                  const meta = src.url ? normalizeUrlMeta(src.url) : null;
                  if (!meta) return null;
                  const title = (src.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
                  return {
                    domain: meta.registrable,
                    title: title || meta.registrable,
                    url: meta.url,
                    channel: classifyCitedChannel(meta.url, title),
                    owned: isProjectOwnedUrl(meta.url, seed.project),
                  };
                })
                .filter((item): item is NonNullable<typeof item> => Boolean(item))
                .slice(0, 6);
              return {
                id: row.id,
                engine: row.engine,
                entry_type: row.entry_type,
                recorded_at: row.recorded_at,
                mention: row.mention,
                citation: row.citation,
                mention_evidence: row.mention_evidence,
                recommendedBrands: parseRecommendedBrands(row.recommended_competitors_json),
                citedSources,
              };
            });
          const planMeta = lookupQuestionPlanMeta(planMaps, {
            id: q.id,
            queryEn: q.query_en,
            queryZh: q.query_zh,
          });
          return {
            questionId: q.id,
            category: q.category ?? 'problem',
            queryZh: q.query_zh,
            queryEn: q.query_en,
            ...(planMeta?.tactic ? { tactic: planMeta.tactic } : {}),
            ...(planMeta?.demandStatus ? { demandStatus: planMeta.demandStatus } : {}),
            ...(planMeta?.demandStrength ? { demandStrength: planMeta.demandStrength } : {}),
            ...(planMeta?.fanoutQueries?.length ? { fanoutQueries: planMeta.fanoutQueries } : {}),
            observations: latestObs,
          };
        });
      });
    },
  };

  const readObservationTool: AgentTool<{
    questionId: string;
    engine: 'chatgpt' | 'google';
  }> = {
    name: 'read_observation_answer',
    description: '按问题编号与平台（如 chatgpt、google）读取本地保存的完整 AI 搜索回答原文及引用来源。',
    parameters: z.object({
      questionId: z.string().min(1),
      engine: z.enum(['chatgpt', 'google']),
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

  const readProjectContextTool: AgentTool<Record<string, never>> = {
    name: 'read_project_context',
    description: '读取当前项目的开放事实档案（project-context.md：产品定位、核心能力、目标受众、同名排除与真实外部被引用竞品）。',
    parameters: z.object({}),
    readOnly: true,
    humanLabel: () => '正在读取当前项目的事实档案（project-context.md）…',
    execute: (_args, ctx) => readProjectContext(ctx.projectId),
  };

  const readWorkspaceFileTool: AgentTool<{ relativePath: string }> = {
    name: 'read_workspace_file',
    description:
      '只读查看当前本地代码仓库中的文本文件（如 package.json、LICENSE、README.md、docs/ 或 src/ 下的代码文件），用于核实真实能力、开源协议、脚本命令或技术边界。严禁读取密钥或 .env 文件。',
    parameters: z.object({
      relativePath: z
        .string()
        .min(1)
        .max(200)
        .describe('相对仓库根目录的路径，如 package.json、LICENSE、docs/getting-started.md'),
    }),
    readOnly: true,
    humanLabel: (args) => `正在核对本地源码文件 ${args.relativePath}…`,
    execute: (args, ctx) => {
      const seed = loadProjectSeed(ctx.projectId);
      if (!isSelfWorkspaceRepo(seed)) {
        return { found: false, message: '当前项目未绑定本机代码工作区，无法直接读取源码文件。' };
      }
      const cleanRel = args.relativePath.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
      if (!isAllowedWorkspaceInspectionPath(cleanRel)) {
        return {
          found: false,
          message: '路径不在允许核验的只读白名单范围内（仅允许 package.json、LICENSE*、README*、docs/**、src/**）。',
        };
      }
      const root = path.resolve(process.cwd());
      const resolved = path.resolve(root, cleanRel);
      if (!resolved.startsWith(`${root}${path.sep}`) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return { found: false, message: `未找到文件：${cleanRel}` };
      }
      const realRoot = fs.realpathSync(root);
      const realTarget = fs.realpathSync(resolved);
      if (!realTarget.startsWith(`${realRoot}${path.sep}`)) {
        return { found: false, message: '路径超出工作区根目录，拒绝读取。' };
      }
      const realRel = path.relative(realRoot, realTarget).split(path.sep).join('/');
      if (!isAllowedWorkspaceInspectionPath(realRel)) {
        return { found: false, message: '符号链接目标不在允许核验的只读白名单范围内。' };
      }
      const content = fs.readFileSync(realTarget, 'utf8');
      return {
        found: true,
        relativePath: cleanRel,
        truncated: content.length > 8_000,
        content: content.slice(0, 8_000),
      };
    },
  };

  return [
    readProjectContextTool,
    listQuestionsTool,
    readObservationTool,
    readOwnedAssetTool,
    listMediaTool,
    readWorkspaceFileTool,
  ];
}

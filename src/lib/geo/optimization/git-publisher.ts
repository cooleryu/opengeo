import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProjectSeed } from '../project-data';
import { appendRunProgress, getOptimizationRun, OptimizationStateError, updateDeliverableRecord } from './repository';
import type { OptimizationDeliverable, OptimizationRun } from './types';

export interface GitHubRepoSlug {
  owner: string;
  repo: string;
}

export interface PublishGitHubOptions {
  deliverableIds?: string[];
  commitMessage?: string;
  /** 测试或自定义环境用：覆盖远程仓库地址（支持本地 bare repo 路径或 file:// URL） */
  remoteUrlOverride?: string;
  /** 测试用：覆盖目标分支名 */
  branchOverride?: string;
  /** 测试或自定义环境用：覆盖本地项目资源根目录 */
  localAssetRootOverride?: string;
}

const SAFE_DOC_PATH_RE = /^(?:README(?:\.[a-zA-Z0-9_-]+)?\.md|(?:docs|public)\/[a-zA-Z0-9._/-]+\.(?:md|html))$/i;
const SAFE_REPO_ASSET_PATH_RE = /^(?:README(?:\.[a-zA-Z0-9_-]+)?\.md|(?:docs|public)\/[a-zA-Z0-9._/-]+\.(?:md|html|png|jpg|jpeg|webp|gif|svg))$/i;
const IMAGE_ASSET_RE = /\.(?:png|jpg|jpeg|webp|gif|svg)$/i;

/** 解析 GitHub 仓库 URL 或 SSH 地址中的 owner/repo。 */
export function parseGitHubRepoSlug(repositoryUrl?: string | null): GitHubRepoSlug | null {
  if (!repositoryUrl) return null;
  const trimmed = repositoryUrl.trim();
  const httpsMatch = trimmed.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }
  const sshMatch = trimmed.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }
  return null;
}

/** 校验并规范化仓库内文档相对路径，阻止越界或误改代码文件。 */
export function validateSafeRepoDocPath(rawPath: string): string {
  const normalized = rawPath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || normalized.includes('\0')) {
    throw new OptimizationStateError(`不安全的仓库文档路径：${rawPath}`, 400);
  }
  if (!SAFE_DOC_PATH_RE.test(normalized)) {
    throw new OptimizationStateError(`只允许推送 README*.md 或 docs/、public/ 下的文档文件：${rawPath}`, 400);
  }
  return normalized;
}

/** 将交付目标（可能是 GitHub blob URL 或相对路径）解析为安全的仓库相对路径；外站地址返回 null。 */
export function resolveRepoRelativeDocPath(
  destination: string,
  slug?: GitHubRepoSlug | null,
): string | null {
  const trimmed = (destination || '').trim();
  if (!trimmed) return null;

  const blobMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/[^/]+\/(.+)$/i);
  if (blobMatch) {
    const [, urlOwner, urlRepo, rawRel] = blobMatch;
    if (slug && (urlOwner.toLowerCase() !== slug.owner.toLowerCase() || urlRepo.toLowerCase() !== slug.repo.toLowerCase())) {
      return null;
    }
    try {
      return validateSafeRepoDocPath(decodeURIComponent(rawRel));
    } catch {
      return null;
    }
  }

  if (/^https?:\/\//i.test(trimmed)) return null;
  try {
    return validateSafeRepoDocPath(trimmed);
  } catch {
    return null;
  }
}

export function isRepoDocDestination(destination: string, repositoryUrl?: string | null): boolean {
  return resolveRepoRelativeDocPath(destination, parseGitHubRepoSlug(repositoryUrl)) !== null;
}

function buildGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_ASKPASS: 'echo',
    SSH_ASKPASS: 'echo',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
  };
}

function runGit(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    env: buildGitEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  }).trim();
}

function parseDefaultBranchFromLsRemote(output: string): string | null {
  const match = output.match(/ref:\s+refs\/heads\/([^\s]+)\s+HEAD/);
  return match?.[1] ?? null;
}

function detectMatchingLocalOriginRemote(slug: GitHubRepoSlug): string | null {
  try {
    const originUrl = runGit(['remote', 'get-url', 'origin'], process.cwd());
    const originSlug = parseGitHubRepoSlug(originUrl);
    if (
      originSlug &&
      originSlug.owner.toLowerCase() === slug.owner.toLowerCase() &&
      originSlug.repo.toLowerCase() === slug.repo.toLowerCase()
    ) {
      return originUrl;
    }
  } catch {
    // 当前目录未必是一个 git 仓库或没有同名 origin，属于正常场景
  }
  return null;
}

function probeRemoteAndBranch(
  candidates: string[],
  branchOverride?: string,
): { remoteUrl: string; defaultBranch: string } {
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      const symrefOut = runGit(['ls-remote', '--symref', candidate, 'HEAD']);
      const detected = parseDefaultBranchFromLsRemote(symrefOut);
      if (branchOverride || detected) {
        return { remoteUrl: candidate, defaultBranch: branchOverride || detected || 'main' };
      }
      const headsOut = runGit(['ls-remote', '--heads', candidate]);
      if (/refs\/heads\/main\b/.test(headsOut)) {
        return { remoteUrl: candidate, defaultBranch: 'main' };
      }
      if (/refs\/heads\/master\b/.test(headsOut)) {
        return { remoteUrl: candidate, defaultBranch: 'master' };
      }
      return { remoteUrl: candidate, defaultBranch: 'main' };
    } catch (error) {
      const msg = error instanceof Error ? error.message.split('\n')[0] : String(error);
      failures.push(`${candidate}: ${msg}`);
    }
  }

  throw new OptimizationStateError(
    `当前电脑尚未配置免交互推送到 GitHub 仓库的权限（已依次尝试 ${candidates.join(' / ')}）。请先在本机完成 SSH 密钥配置（ssh -T git@github.com）或运行 gh auth login 后再试。\n详情：${failures[0] || ''}`.trim(),
    422,
  );
}

function writeRepoFile(repoDir: string, relPath: string, content: string): void {
  const fullPath = path.resolve(repoDir, relPath);
  const root = path.resolve(repoDir);
  if (fullPath === root || !fullPath.startsWith(`${root}${path.sep}`)) {
    throw new OptimizationStateError(`非法路径：${relPath}`, 400);
  }
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function deleteRepoFileIfExists(repoDir: string, relPath: string): boolean {
  const fullPath = path.resolve(repoDir, relPath);
  const root = path.resolve(repoDir);
  if (fullPath === root || !fullPath.startsWith(`${root}${path.sep}`)) {
    return false;
  }
  if (!fs.existsSync(fullPath)) return false;
  fs.unlinkSync(fullPath);
  return true;
}

function ensureGitAuthorInTempClone(repoDir: string): void {
  let hasName = false;
  let hasEmail = false;
  try {
    hasName = Boolean(runGit(['config', '--get', 'user.name'], repoDir));
  } catch {
    hasName = false;
  }
  try {
    hasEmail = Boolean(runGit(['config', '--get', 'user.email'], repoDir));
  } catch {
    hasEmail = false;
  }
  if (!hasName) runGit(['config', 'user.name', 'OpenGEO Studio'], repoDir);
  if (!hasEmail) runGit(['config', 'user.email', 'opengeo-studio@users.noreply.github.com'], repoDir);
}

interface DeliverablePushPlan {
  deliverable: OptimizationDeliverable;
  primaryPath: string;
  writes: Array<{ path: string; content: string }>;
  deletes: string[];
}

function extractRelativeRepoRefs(docPath: string, content: string): string[] {
  const refs: string[] = [];
  const rawMatches: string[] = [];

  for (const m of content.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    if (m[1]) rawMatches.push(m[1]);
  }
  for (const m of content.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)) {
    if (m[1]) rawMatches.push(m[1]);
  }

  const baseDir = path.posix.dirname(docPath.replace(/\\/g, '/'));
  for (const raw of rawMatches) {
    const cleaned = raw.trim().split(/[?#]/)[0]?.trim() || '';
    if (!cleaned || /^(?:https?:|mailto:|tel:|data:|javascript:|\/\/)/i.test(cleaned) || cleaned.startsWith('#')) {
      continue;
    }
    const stripped = cleaned.replace(/^\/+/, '');
    const joined =
      cleaned.startsWith('/') || baseDir === '.'
        ? stripped
        : path.posix.join(baseDir, stripped);
    const normalized = path.posix.normalize(joined).replace(/^\/+/, '');
    if (!normalized || normalized.startsWith('..') || normalized.includes('\0')) continue;
    if (!SAFE_REPO_ASSET_PATH_RE.test(normalized)) continue;
    refs.push(normalized);
  }
  return Array.from(new Set(refs));
}

function collectMissingLocalCompanionAssets(
  cloneDir: string,
  localRoot: string,
  initialWrites: Array<{ path: string; content: string }>,
  deletedPaths: Set<string>,
): string[] {
  const realLocalRoot = fs.realpathSync(path.resolve(localRoot));
  const realCloneDir = fs.realpathSync(path.resolve(cloneDir));
  const writtenSet = new Set(initialWrites.map((w) => w.path));
  const copied: string[] = [];
  const scanned = new Set<string>();
  const queue: Array<{ path: string; content: string; depth: number }> = initialWrites.map((w) => ({
    path: w.path,
    content: w.content,
    depth: 0,
  }));

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (scanned.has(current.path) || current.depth > 2) continue;
    scanned.add(current.path);

    for (const relPath of extractRelativeRepoRefs(current.path, current.content)) {
      if (writtenSet.has(relPath) || deletedPaths.has(relPath)) continue;
      const dstPath = path.resolve(realCloneDir, relPath);
      if (!dstPath.startsWith(`${realCloneDir}${path.sep}`)) continue;

      const srcPath = path.resolve(realLocalRoot, relPath);
      if (!srcPath.startsWith(`${realLocalRoot}${path.sep}`)) continue;
      if (!fs.existsSync(srcPath)) continue;
      const lstat = fs.lstatSync(srcPath);
      if (!lstat.isFile() || lstat.isSymbolicLink()) continue;
      const realSrc = fs.realpathSync(srcPath);
      if (!realSrc.startsWith(`${realLocalRoot}${path.sep}`)) continue;

      const dstExists = fs.existsSync(dstPath);
      if (dstExists) {
        if (!IMAGE_ASSET_RE.test(relPath)) continue;
        const dstLstat = fs.lstatSync(dstPath);
        if (!dstLstat.isFile() || dstLstat.isSymbolicLink()) continue;
        if (fs.readFileSync(srcPath).equals(fs.readFileSync(dstPath))) continue;
      }

      fs.mkdirSync(path.dirname(dstPath), { recursive: true });
      fs.copyFileSync(srcPath, dstPath);
      writtenSet.add(relPath);
      copied.push(relPath);

      if (/\.md$/i.test(relPath) && current.depth + 1 <= 2) {
        queue.push({
          path: relPath,
          content: fs.readFileSync(srcPath, 'utf8'),
          depth: current.depth + 1,
        });
      }
    }
  }

  return copied;
}

/**
 * 将已采用的仓库文档（含配套多语言文件与旧路径清理）通过临时浅克隆非交互式提交并推送到 GitHub 默认分支。
 * 不会触碰用户当前工作区未提交代码或开发分支。
 */
export function publishRepoDeliverablesToGitHub(
  projectId: string,
  runId: string,
  options: PublishGitHubOptions = {},
): OptimizationRun {
  const run = getOptimizationRun(projectId, runId);
  if (!run) throw new OptimizationStateError('没有找到对应的优化任务。', 404);

  const seed = loadProjectSeed(projectId);
  const slug = parseGitHubRepoSlug(seed.project.repositoryUrl);
  if (!slug && !options.remoteUrlOverride) {
    throw new OptimizationStateError('当前项目未配置有效的 GitHub 仓库地址，无法自动推送到远程仓库。', 400);
  }

  const filterSet = options.deliverableIds?.length ? new Set(options.deliverableIds) : null;
  const candidateDeliverables = run.deliverables.filter((deliv) => {
    if (filterSet && !filterSet.has(deliv.id)) return false;
    if (deliv.status !== 'applied') return false;
    return resolveRepoRelativeDocPath(deliv.destination, slug) !== null;
  });

  if (!candidateDeliverables.length) {
    throw new OptimizationStateError('没有找到可推送到 GitHub 仓库的已采用文档（需先点击“采用这一篇”）。', 400);
  }

  const plans: DeliverablePushPlan[] = candidateDeliverables.map((deliv) => {
    const primaryPath = resolveRepoRelativeDocPath(deliv.destination, slug)!;
    const writes: Array<{ path: string; content: string }> = [{ path: primaryPath, content: deliv.afterContent }];
    const deletes: string[] = [];

    for (const companion of deliv.companionFiles ?? []) {
      if (companion.reviewOnly) continue;
      const compPath = validateSafeRepoDocPath(companion.path);
      writes.push({ path: compPath, content: companion.content });
      for (const delTarget of companion.deletePaths ?? []) {
        const safeDel = validateSafeRepoDocPath(delTarget);
        if (safeDel !== primaryPath && !writes.some((w) => w.path === safeDel)) {
          deletes.push(safeDel);
        }
      }
    }

    return { deliverable: deliv, primaryPath, writes, deletes };
  });

  const matchedOrigin = slug ? detectMatchingLocalOriginRemote(slug) : null;
  const remoteCandidates: string[] = [];
  if (options.remoteUrlOverride) {
    remoteCandidates.push(options.remoteUrlOverride);
  } else if (slug) {
    if (matchedOrigin) remoteCandidates.push(matchedOrigin);
    remoteCandidates.push(`git@github.com:${slug.owner}/${slug.repo}.git`);
    remoteCandidates.push(`https://github.com/${slug.owner}/${slug.repo}.git`);
  }

  const uniqueCandidates = Array.from(new Set(remoteCandidates));
  const { remoteUrl, defaultBranch } = probeRemoteAndBranch(uniqueCandidates, options.branchOverride);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-gh-push-'));
  const cloneDir = path.join(tempRoot, 'repo');

  try {
    runGit(['clone', '--depth', '1', '--branch', defaultBranch, '--single-branch', remoteUrl, cloneDir]);

    const touchedPaths = new Set<string>();
    const deletedPaths = new Set<string>();
    const allWrites: Array<{ path: string; content: string }> = [];
    for (const plan of plans) {
      for (const item of plan.writes) {
        writeRepoFile(cloneDir, item.path, item.content);
        touchedPaths.add(item.path);
        allWrites.push(item);
      }
      for (const delPath of plan.deletes) {
        deletedPaths.add(delPath);
        if (deleteRepoFileIfExists(cloneDir, delPath)) {
          touchedPaths.add(delPath);
        }
      }
    }

    const extraAssetPaths: string[] = [];
    const localAssetRoot = options.localAssetRootOverride ?? (matchedOrigin ? process.cwd() : undefined);
    if (localAssetRoot) {
      const copiedAssets = collectMissingLocalCompanionAssets(
        cloneDir,
        localAssetRoot,
        allWrites,
        deletedPaths,
      );
      for (const assetPath of copiedAssets) {
        touchedPaths.add(assetPath);
        extraAssetPaths.push(assetPath);
      }
    }

    const statusOut = runGit(['status', '--porcelain'], cloneDir);
    let commitHash = runGit(['rev-parse', '--short', 'HEAD'], cloneDir);

    if (statusOut.length > 0) {
      ensureGitAuthorInTempClone(cloneDir);
      runGit(['add', '-A', '--', ...Array.from(touchedPaths)], cloneDir);
      const docList = plans.map((p) => p.primaryPath).join(', ');
      const message = options.commitMessage || `docs: publish ${docList} via OpenGEO`;
      runGit(['commit', '-m', message], cloneDir);
      runGit(['push', 'origin', `HEAD:${defaultBranch}`], cloneDir);
      commitHash = runGit(['rev-parse', '--short', 'HEAD'], cloneDir);
    }

    const now = new Date().toISOString();
    for (const plan of plans) {
      const pushedPaths = Array.from(new Set([...plan.writes.map((w) => w.path), ...extraAssetPaths]));
      const publishedUrl = slug
        ? `https://github.com/${slug.owner}/${slug.repo}/blob/${defaultBranch}/${plan.primaryPath}`
        : plan.deliverable.appliedRecord?.publishedUrl;

      updateDeliverableRecord(projectId, plan.deliverable.id, {
        status: 'applied',
        appliedRecord: {
          appliedAt: now,
          mode: 'github_pushed',
          destination: plan.primaryPath,
          ...(publishedUrl ? { publishedUrl } : {}),
          commitHash,
          branch: defaultBranch,
          pushedPaths,
          note:
            statusOut.length > 0
              ? `已推送至 ${defaultBranch} 分支（${commitHash}）`
              : `远程仓库 ${defaultBranch} 分支已是最新内容（${commitHash}）`,
        },
      });
    }

    appendRunProgress(projectId, runId, {
      at: now,
      agentId: 'github-publisher',
      kind: 'done',
      message: `已将 ${plans.length} 套已采用文档推送到 ${defaultBranch}（提交 ${commitHash}），等待搜索引擎重新抓取收录。`,
    });

    return getOptimizationRun(projectId, runId)!;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

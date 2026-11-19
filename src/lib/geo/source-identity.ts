export const SAFE_GH_SEGMENT_RE = /^[A-Za-z0-9_.-]{1,100}$/;

export const GITHUB_NON_REPO_OWNERS = new Set([
  'topics',
  'search',
  'orgs',
  'users',
  'features',
  'pricing',
  'about',
  'settings',
  'explore',
  'marketplace',
  'sponsors',
  'collections',
  'events',
  'login',
  'signup',
  'trending',
  'blog',
  'customer-stories',
  'security',
  'enterprise',
  'readme',
  'pulls',
  'issues',
  'notifications',
]);

export const TWO_PART_PUBLIC_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.jp',
  'ne.jp',
  'or.jp',
  'com.cn',
  'net.cn',
  'org.cn',
  'com.br',
  'co.in',
  'co.kr',
  'co.nz',
  'com.sg',
  'com.hk',
  'com.tw',
  'github.io',
  'gitlab.io',
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'readthedocs.io',
  'gitbook.io',
  'substack.com',
]);

export function extractRegistrableDomainParts(
  host: string,
): { registrableDomain: string; sld: string } | null {
  const labels = host.toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (labels.length < 2) return null;
  if (labels.length >= 3) {
    const tailTwo = `${labels[labels.length - 2]}.${labels[labels.length - 1]}`;
    if (TWO_PART_PUBLIC_SUFFIXES.has(tailTwo)) {
      const sld = labels[labels.length - 3] ?? '';
      return sld
        ? { registrableDomain: `${sld}.${tailTwo}`, sld }
        : { registrableDomain: tailTwo, sld: tailTwo.split('.')[0] ?? '' };
    }
  }
  const sld = labels[labels.length - 2] ?? '';
  const tld = labels[labels.length - 1] ?? '';
  return sld && tld ? { registrableDomain: `${sld}.${tld}`, sld } : null;
}

export interface ParsedGitHubRepo {
  owner: string;
  repo: string;
  url: string;
  key: string;
}

export function parseGitHubRepoUrl(
  rawUrl: string,
  options?: {
    allowSubpaths?: boolean;
    allowTreeOrReadme?: boolean;
    allowSchemeless?: boolean;
  },
): ParsedGitHubRepo | null {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return null;

  let candidate = trimmed;
  if (options?.allowSchemeless && !/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate.replace(/^\/+/, '')}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.hostname.replace(/^www\./i, '').toLowerCase() !== 'github.com') return null;

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, '');
  if (!owner || !repo) return null;
  if (!SAFE_GH_SEGMENT_RE.test(owner) || !SAFE_GH_SEGMENT_RE.test(repo)) return null;
  if (GITHUB_NON_REPO_OWNERS.has(owner.toLowerCase())) return null;

  const allowSubpaths = options?.allowSubpaths ?? !options?.allowTreeOrReadme;
  if (segments.length > 2 && !allowSubpaths) {
    if (options?.allowTreeOrReadme) {
      const isTree = segments[2] === 'tree';
      const isReadmeBlob =
        segments[2] === 'blob' && /readme/i.test(segments[segments.length - 1] ?? '');
      if (!isTree && !isReadmeBlob) return null;
    } else {
      return null;
    }
  }

  return {
    owner,
    repo,
    url: `https://github.com/${owner}/${repo}`,
    key: `github.com/${owner.toLowerCase()}/${repo.toLowerCase()}`,
  };
}

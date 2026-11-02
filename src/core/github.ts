import type { LaunchTarget } from './types';

const RESERVED = new Set(['settings','marketplace','features','topics','collections','explore','login','logout','signup','organizations','orgs','users','search','notifications','new','pulls','issues','codespaces','sponsors','apps','about','security','enterprise','pricing','readme','site']);
export function parseGitHubURL(value: string) {
  const url = new URL(value);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (url.origin !== 'https://github.com' || url.username || url.password || parts.length < 2 || RESERVED.has(parts[0].toLowerCase()) || !/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(parts[0]) || !/^[\w.-]{1,100}$/.test(parts[1]) || parts[1] === '.' || parts[1] === '..') throw new Error('Open a GitHub repository or pull request first.');
  return {owner:parts[0],repo:parts[1],route:parts.slice(2),url};
}
type Ref = {ref:string; object:{sha:string;type?:string}};
export class GitHub {
  constructor(private readonly request: typeof fetch = globalThis.fetch.bind(globalThis)) {}
  private async get(path: string): Promise<any> {
    const response = await this.request(`https://api.github.com${path}`, {headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},credentials:'omit',redirect:'error',signal:AbortSignal.timeout(20000)});
    if (!response.ok) {
      if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) throw new Error('GitHub API rate limit reached. Wait for its reset, then retry. No Sprite was created.');
      if (response.status === 404) throw new Error('Repository or revision is unavailable. Only public GitHub repositories are supported.');
      if (response.status === 409) throw new Error('This repository is empty or its revision is unavailable.');
      throw new Error(`GitHub lookup failed (HTTP ${response.status}).`);
    }
    return response.json();
  }
  async resolve(value: string, _refHint?: string): Promise<LaunchTarget> {
    const {owner,repo,route,url} = parseGitHubURL(value);
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const metadata = await this.get(base);
    if (metadata.private) throw new Error('Only public GitHub repositories are supported.');
    const cloneUrl = `https://github.com/${owner}/${repo}.git`;
    const common = {owner,repo,cloneUrl,sourceUrl:url.origin+url.pathname};
    if (route[0] === 'pull' && /^\d+$/.test(route[1] || '')) {
      const number = Number(route[1]);
      const pr = await this.get(`${base}/pulls/${number}`);
      return this.checked({...common,kind:'pr',ref:pr.head.ref,sha:pr.head.sha,fetchRef:`refs/pull/${number}/head`,prNumber:number});
    }
    if (route[0] === 'commit') {
      if (!/^[a-f\d]{7,40}$/i.test(route[1] || '')) throw new Error('Invalid GitHub commit.');
      const commit = await this.get(`${base}/commits/${route[1]}`);
      return this.checked({...common,kind:'commit',ref:route[1],sha:commit.sha,fetchRef:commit.sha});
    }
    if (route[0] === 'tree' || route[0] === 'blob') {
      const path = route.slice(1).join('/');
      if (!path) throw new Error('No GitHub revision selected.');
      if (/^[a-f\d]{7,40}(?:\/|$)/i.test(path)) {
        const commit = await this.get(`${base}/commits/${path.split('/')[0]}`);
        return this.checked({...common,kind:'commit',ref:path.split('/')[0],sha:commit.sha,fetchRef:commit.sha});
      }
      // Matching refs resolves branch names containing slashes without guessing at file boundaries.
      const prefix = encodeURIComponent(route[1]);
      const [heads,tags] = await Promise.all([this.get(`${base}/git/matching-refs/heads/${prefix}`),this.get(`${base}/git/matching-refs/tags/${prefix}`)]);
      const matches = [...heads,...tags].filter((r:Ref)=>{const name=r.ref.replace(/^refs\/(heads|tags)\//,''); return path === name || path.startsWith(`${name}/`);}).sort((a:Ref,b:Ref)=>b.ref.replace(/^refs\/(heads|tags)\//,'').length-a.ref.replace(/^refs\/(heads|tags)\//,'').length);
      if (!matches.length) throw new Error('The selected branch or tag no longer exists.');
      const match:Ref=matches[0];
      const ref = match.ref.replace(/^refs\/(heads|tags)\//,'');
      const kind = match.ref.startsWith('refs/heads/') ? 'branch' : 'tag';
      const sha = match.object.type === 'tag' ? (await this.get(`${base}/commits/${encodeURIComponent(ref)}`)).sha : match.object.sha;
      return this.checked({...common,kind,ref,sha,fetchRef:match.ref});
    }
    const ref = metadata.default_branch;
    if (!ref) throw new Error('This repository has no default branch.');
    const commit = await this.get(`${base}/commits/${encodeURIComponent(ref)}`);
    return this.checked({...common,kind:'branch',ref,sha:commit.sha,fetchRef:`refs/heads/${ref}`});
  }
  private checked(target:LaunchTarget):LaunchTarget {
    if (!/^[a-f\d]{40}$/i.test(target.sha) || typeof target.ref !== 'string' || target.ref.length > 1024) throw new Error('GitHub returned an invalid source revision.');
    return target;
  }
}

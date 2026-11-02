import { describe, expect, it, vi } from 'vitest';
import { GitHub, parseGitHubURL } from '../src/core/github';

const sha = 'a'.repeat(40);
const repo = { private: false, archived: false, default_branch: 'main', clone_url: 'https://github.com/acme/demo.git' };
function github(responses: Record<string, unknown>) {
  return new GitHub(vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    return path in responses ? new Response(JSON.stringify(responses[path]), {status: 200}) : new Response('{}', {status: 404});
  }) as typeof fetch);
}
describe('GitHub source resolution', () => {
  it('rejects lookalike origins and non-repository pages', () => {
    for (const url of ['https://github.com.evil/acme/demo', 'https://github.com/settings/profile', 'https://github.com/acme', 'http://github.com/acme/demo']) {
      expect(() => parseGitHubURL(url)).toThrow();
    }
  });
  it('pins a repository default branch before provisioning', async () => {
    const client = github({'/repos/acme/demo': repo, '/repos/acme/demo/commits/main': {sha}});
    expect(await client.resolve('https://github.com/acme/demo/issues')).toMatchObject({kind:'branch', ref:'main', sha, fetchRef:'refs/heads/main'});
  });
  it('fetches PR heads from the base repo even after a fork is deleted', async () => {
    const client = github({'/repos/acme/demo':repo, '/repos/acme/demo/pulls/17': {head:{sha, ref:'feature/a', repo:null}}});
    expect(await client.resolve('https://github.com/acme/demo/pull/17/files')).toMatchObject({kind:'pr', sha, fetchRef:'refs/pull/17/head', cloneUrl:repo.clone_url});
  });
  it('resolves slash branches without confusing directories with the ref', async () => {
    const client = github({'/repos/acme/demo':repo, '/repos/acme/demo/git/matching-refs/heads/feature':[{ref:'refs/heads/feature/a',object:{sha}}], '/repos/acme/demo/git/matching-refs/tags/feature':[]});
    expect(await client.resolve('https://github.com/acme/demo/tree/feature/a/src')).toMatchObject({ref:'feature/a', sha, kind:'branch'});
  });
  it('resolves tags and commit pages', async () => {
    const client = github({'/repos/acme/demo':repo, '/repos/acme/demo/git/matching-refs/heads/v1':[], '/repos/acme/demo/git/matching-refs/tags/v1':[{ref:'refs/tags/v1',object:{sha,type:'commit'}}], [`/repos/acme/demo/commits/${sha}`]:{sha}});
    expect(await client.resolve('https://github.com/acme/demo/tree/v1')).toMatchObject({ref:'v1',kind:'tag'});
    expect(await client.resolve(`https://github.com/acme/demo/commit/${sha}`)).toMatchObject({sha,kind:'commit'});
  });
  it('blocks private repos and reports rate limits distinctly', async () => {
    await expect(github({'/repos/acme/demo':{...repo,private:true}}).resolve('https://github.com/acme/demo')).rejects.toThrow(/public/i);
    const client = new GitHub(vi.fn(async()=>new Response('{}',{status:403,headers:{'x-ratelimit-remaining':'0'}})) as typeof fetch);
    await expect(client.resolve('https://github.com/acme/demo')).rejects.toThrow(/rate limit/i);
  });
});

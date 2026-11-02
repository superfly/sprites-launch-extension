import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePreviewAuthPolicy, previewAuthAllowed } from '../src/core/preview-policy.mjs';

afterEach(()=>vi.unstubAllEnvs());

describe('qualified preview organization policy',()=>{
  it('defaults to no preview credentials, even when an organization list is present',()=>{
    expect(parsePreviewAuthPolicy(undefined,undefined)).toEqual({enabled:false,orgIds:[]});
    const disabled=parsePreviewAuthPolicy('false','42');
    expect(previewAuthAllowed({token:'qualified/42/id/secret'},disabled)).toBe(false);
  });

  it('qualifies canonical numeric identities, not descriptive or relabeled slugs',()=>{
    const policy=parsePreviewAuthPolicy('true',' 00042,84,42 ');
    expect(policy.orgIds).toEqual(['42','84']);
    expect(previewAuthAllowed({token:'qualified/42/id/secret'},policy)).toBe(true);
    expect(previewAuthAllowed({token:'another-label/00042/id/secret'},policy)).toBe(true);
    expect(previewAuthAllowed({token:'qualified/43/id/secret'},policy)).toBe(false);
    expect(previewAuthAllowed({token:'qualified/9007199254740993/id/secret'},parsePreviewAuthPolicy(true,'9007199254740992'))).toBe(false);
  });

  it.each([undefined,'',' ','*','all','qualified','42,','42,,84','-42','0','1e3','42.0','9223372036854775808','42\n84'])('rejects enabled builds with an empty or malformed allowlist: %s',ids=>{
    expect(()=>parsePreviewAuthPolicy('true',ids)).toThrow(/VITE_PREVIEW_AUTH_ORG_IDS/);
  });

  it.each(['TRUE','yes',1,{},null])('rejects an ambiguous build switch: %s',enabled=>{
    expect(()=>parsePreviewAuthPolicy(enabled,'42')).toThrow('VITE_PREVIEW_AUTH_VERIFIED');
  });

  it.each([
    undefined,'qualified/42/secret','qualified/42/id/secret/extra','qualified//id/secret',
    'qualified/0/id/secret','qualified/42//secret','qualified/42/id/',
    'qualified/42/id/secret\n','Bearer qualified/42/id/secret','FlyV1 macaroon',
  ])('denies ambiguous, malformed, or unsupported token identities: %s',token=>{
    const profile=token===undefined?undefined:{token};
    expect(previewAuthAllowed(profile,parsePreviewAuthPolicy(true,'42'))).toBe(false);
  });

  it.each(['','42,','*'])('fails actual packaging before building when qualification is invalid: %s',ids=>{
    expect(()=>execFileSync(process.execPath,['scripts/build.mjs'],{cwd:process.cwd(),env:{...process.env,VITE_PREVIEW_AUTH_VERIFIED:'true',VITE_PREVIEW_AUTH_ORG_IDS:ids},stdio:'pipe'})).toThrow();
  });
});

describe('snapshot preview eligibility',()=>{
  it('tracks the connected profiles by numeric identity without exposing credentials',async()=>{
    vi.stubEnv('VITE_PREVIEW_AUTH_VERIFIED','true');
    vi.stubEnv('VITE_PREVIEW_AUTH_ORG_IDS','42');
    vi.resetModules();
    const {Store}=await import('../src/core/storage');
    const local:Record<string,unknown>={};
    vi.stubGlobal('chrome',{storage:{local:{get:vi.fn(async(key:string)=>({[key]:local[key]})),set:vi.fn(async(data:Record<string,unknown>)=>{Object.assign(local,data);})}}});
    try{
      const store=new Store();
      await store.saveProfile({org:'qualified-label',token:'qualified-label/42/id/secret-one'});
      await store.saveProfile({org:'unqualified',token:'unqualified/84/id/secret-two'});
      let snapshot=await store.snapshot();
      expect(snapshot.settings).toMatchObject({currentOrg:'unqualified',previewAuthVerified:false,previewAuthOrganizations:['qualified-label']});
      expect(JSON.stringify(snapshot)).not.toContain('secret');
      await store.select('qualified-label');
      snapshot=await store.snapshot();
      expect(snapshot.settings.previewAuthVerified).toBe(true);
      await store.logout('qualified-label');
      expect((await store.snapshot()).settings.previewAuthOrganizations).toEqual([]);
    }finally{vi.unstubAllGlobals();}
  });
});

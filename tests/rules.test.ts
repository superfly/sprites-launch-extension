import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Rules } from '../src/core/rules';
import { Store } from '../src/core/storage';
import type { LaunchRecord } from '../src/core/types';

const profile={org:'test-org',token:'fixture-management-credential'};
const record={id:'a'.repeat(36),org:profile.org,spriteName:'gh-demo-123',url:'https://gh-demo-123.sprites.app'} as LaunchRecord;
let installed:chrome.declarativeNetRequest.Rule[];
type RuleChange={removeRuleIds?:number[];addRules?:chrome.declarativeNetRequest.Rule[]};
let update:ReturnType<typeof vi.fn<(request:RuleChange)=>Promise<void>>>;
beforeEach(()=>{
  installed=[];
  const local:Record<string,unknown>={spritesLaunch:{profiles:{[profile.org]:profile},currentOrg:profile.org,launches:{},overrides:{}}},session:Record<string,unknown>={};
  const area=(data:Record<string,unknown>)=>({get:vi.fn(async(key:string|null)=>key===null?{...data}:{[key]:data[key]}),set:vi.fn(async(value:Record<string,unknown>)=>{Object.assign(data,value);}),remove:vi.fn(async(keys:string|string[])=>{for(const key of [keys].flat())delete data[key];})});
  update=vi.fn(async({removeRuleIds=[],addRules=[]}:{removeRuleIds?:number[];addRules?:chrome.declarativeNetRequest.Rule[]})=>{installed=installed.filter(rule=>!removeRuleIds.includes(rule.id));installed.push(...addRules);});
  vi.stubGlobal('chrome',{runtime:{id:'self'},storage:{local:area(local),session:area(session)},declarativeNetRequest:{getSessionRules:vi.fn(async()=>installed),updateSessionRules:update}});
});

describe('authorization rule lifetime',()=>{
  it.each(['terminal','preview'] as const)('rejects a delayed %s request holding a profile captured before logout',async(kind)=>{
    const rules=new Rules(),store=new Store();
    let release!:()=>void;
    const paused=new Promise<void>(resolve=>{release=resolve;});
    const late=(async()=>{await paused;return kind==='terminal'?rules.terminal(record,profile):rules.preview(record,profile,7);})();
    await store.logout(profile.org);
    await rules.clear();
    release();
    await expect(late).rejects.toThrow(/Connect|credentials/);
    expect(installed).toEqual([]);
    expect(update.mock.calls.every(([request])=>!request.addRules?.length)).toBe(true);
  });
  it.each(['terminal','preview'] as const)('rejects stale or cross-org credentials for %s after replacement',async(kind)=>{
    await new Store().saveProfile({...profile,token:'replacement-credential'});
    const rules=new Rules();
    await expect(kind==='terminal'?rules.terminal(record,profile):rules.preview(record,profile,7)).rejects.toThrow('credentials changed');
    await expect(rules.terminal(record,{org:'other-org',token:'replacement-credential'})).rejects.toThrow();
    expect(installed).toEqual([]);
  });
  it('serializes logout cleanup behind an already-started rule installation',async()=>{
    let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const realUpdate=update.getMockImplementation()!;
    update.mockImplementation(async request=>{if(request.addRules?.length){entered();await gate;}await realUpdate(request);});
    const rules=new Rules();
    const pending=rules.terminal(record,profile);
    await started;
    await new Store().logout(profile.org);
    const clear=rules.clear();
    release();
    await pending;await clear;
    expect(installed).toEqual([]);
    expect((await chrome.storage.session.get(null))).toEqual({});
  });
  it('still installs correctly scoped rules for current credentials',async()=>{
    const rules=new Rules();
    await rules.terminal(record,profile);await rules.preview(record,profile,7);
    expect(installed).toHaveLength(2);
    expect(installed[0].condition.initiatorDomains).toEqual(['self']);
    expect(installed[1].condition.tabIds).toEqual([7]);
  });
});

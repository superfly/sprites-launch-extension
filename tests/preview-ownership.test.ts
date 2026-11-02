import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Controller } from '../src/core/controller';
import { Store } from '../src/core/storage';
import type { SpritesAPI } from '../src/core/api';
import type { Rules } from '../src/core/rules';
import type { LaunchRecord } from '../src/core/types';

// Exercise the gated release path without enabling it in any built extension.
vi.mock('../src/core/storage',async original=>({...await original<typeof import('../src/core/storage')>(),PREVIEW_AUTH_VERIFIED:true}));

const record:LaunchRecord={id:'12345678-1234-4321-1234-123456789abc',org:'owning-org',spriteName:'gh-example-12345678',spriteId:'original-id',url:'https://original.sprites.app',phase:'ready',provisioned:true,createdAt:'2026-11-02T00:00:00Z',updatedAt:'2026-11-02T00:00:00Z',target:{owner:'example',repo:'app',kind:'branch',ref:'main',sha:'a'.repeat(40),cloneUrl:'https://github.com/example/app.git',fetchRef:'refs/heads/main',sourceUrl:'https://github.com/example/app'}};

beforeEach(()=>{
  const local:Record<string,unknown>={},session:Record<string,unknown>={};
  const area=(data:Record<string,unknown>)=>({get:vi.fn(async(key:string|null)=>key===null?{...data}:{[key]:data[key]}),set:vi.fn(async(value:Record<string,unknown>)=>{Object.assign(data,value);}),remove:vi.fn(async(keys:string|string[])=>{for(const key of [keys].flat())delete data[key];})});
  vi.stubGlobal('chrome',{storage:{local:area(local),session:area(session)},tabs:{create:vi.fn(async()=>({id:17})),update:vi.fn(async()=>{}),get:vi.fn(async()=>({id:17,url:record.url}))}});
});

async function environment() {
  const store=new Store();
  await store.saveProfile({org:record.org,token:'private-org-token'});
  await store.save({...record});
  const api={get:vi.fn(async()=>({id:record.spriteId,name:record.spriteName,url:record.url,url_settings:{auth:'sprite'}})),read:vi.fn()};
  const rules={preview:vi.fn(async()=>{}),clear:vi.fn(async()=>{})};
  const apiFactory=vi.fn(()=>api as unknown as SpritesAPI);
  return {store,api,rules,apiFactory,controller:new Controller(store,rules as unknown as Rules,undefined,apiFactory)};
}

describe('private preview ownership',()=>{
  it('checks the owning organization and current Sprite before injecting or navigating',async()=>{
    const {controller,store,api,rules,apiFactory}=await environment();
    await store.saveProfile({org:'another-org',token:'another-token'});
    await expect(controller.preview(record.id)).resolves.toEqual({tabId:17,authentication:'extension'});
    expect(apiFactory).toHaveBeenCalledExactlyOnceWith({org:record.org,token:'private-org-token'});
    expect(api.get).toHaveBeenCalledExactlyOnceWith(record.spriteName);
    expect(api.get.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(chrome.tabs.create).mock.invocationCallOrder[0]);
    expect(rules.preview.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(chrome.tabs.update).mock.invocationCallOrder[0]);
    expect(chrome.tabs.update).toHaveBeenCalledWith(17,{url:record.url});
  });

  it('refuses a Sprite recreated under a retained launch name',async()=>{
    const {controller,api,rules}=await environment();
    api.get.mockResolvedValue({id:'recreated-id',name:record.spriteName,url:record.url!,url_settings:{auth:'sprite'}});
    await expect(controller.preview(record.id)).rejects.toThrow('different Sprite');
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(rules.preview).not.toHaveBeenCalled();
  });

  it.each([{auth:'public'},{auth:'unknown'},undefined])('refuses public or unverified URL settings: %o',async(settings)=>{
    const {controller,api,rules}=await environment();
    api.get.mockResolvedValue({id:record.spriteId,name:record.spriteName,url:record.url,url_settings:settings} as never);
    await expect(controller.preview(record.id)).rejects.toThrow('privacy could not be verified');
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(rules.preview).not.toHaveBeenCalled();
  });

  it('accepts the API legacy null setting, which requires private authentication',async()=>{
    const {controller,api,rules}=await environment();
    api.get.mockResolvedValue({id:record.spriteId,name:record.spriteName,url:record.url,url_settings:null} as never);
    await expect(controller.preview(record.id)).resolves.toMatchObject({tabId:17});
    expect(rules.preview).toHaveBeenCalledOnce();
  });

  it('uses only the current API-returned hostname for an unchanged Sprite identity',async()=>{
    const {controller,store,api,rules}=await environment();
    const current='https://current.sprites.app';
    api.get.mockResolvedValue({id:record.spriteId,name:record.spriteName,url:current,url_settings:{auth:'sprite'}});
    await controller.preview(record.id);
    expect(chrome.tabs.update).toHaveBeenCalledWith(17,{url:current});
    expect(rules.preview).toHaveBeenCalledWith(expect.objectContaining({url:current}),expect.anything(),17);
    expect((await store.record(record.id)).url).toBe(current);
  });

  it('opens automatic previews in the background while manual previews take focus',async()=>{
    const {controller}=await environment();
    await controller.preview(record.id,false);
    expect(chrome.tabs.create).toHaveBeenLastCalledWith({url:'about:blank',active:false});
    await controller.preview(record.id);
    expect(chrome.tabs.create).toHaveBeenLastCalledWith({url:'about:blank',active:true});
  });

  it.each(['https://unrelated.example','https://original.sprites.app/?token=unsafe'])('rejects invalid current API URLs: %s',async(url)=>{
    const {controller,api,rules}=await environment();
    api.get.mockResolvedValue({id:record.spriteId,name:record.spriteName,url,url_settings:{auth:'sprite'}});
    await expect(controller.preview(record.id)).rejects.toThrow('unsupported preview URL');
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(rules.preview).not.toHaveBeenCalled();
  });
});

describe('preview rule restoration',()=>{
  it.each([
    {id:record.spriteId,url:record.url,url_settings:{auth:'sprite'},restore:true},
    {id:record.spriteId,url:record.url,url_settings:null,restore:true},
    {id:'recreated-id',url:record.url,url_settings:{auth:'sprite'},restore:false},
    {id:record.spriteId,url:'https://changed.sprites.app',url_settings:{auth:'sprite'},restore:false},
    {id:record.spriteId,url:record.url,url_settings:{auth:'public'},restore:false},
    {id:record.spriteId,url:record.url,url_settings:undefined,restore:false},
  ])('restores only current, owned, private preview bindings: %o',async({restore,...sprite})=>{
    const {controller,api,rules}=await environment();
    await chrome.storage.local.set({previewBindings:{17:{launchId:record.id,hostname:'original.sprites.app'}}});
    api.get.mockResolvedValue({name:record.spriteName,...sprite} as never);
    await controller.rebuildRules();
    expect(rules.clear).toHaveBeenCalledOnce();
    expect(api.get).toHaveBeenCalledExactlyOnceWith(record.spriteName);
    expect(rules.preview).toHaveBeenCalledTimes(restore?1:0);
  });
});

describe('OpenClaw private-file errors',()=>{
  const secret='private-application-credential-'.repeat(2);
  const unavailable='OpenClaw connection configuration is unavailable.';
  it.each([
    `${secret} is malformed JSON`,
    JSON.stringify(null),
    JSON.stringify({gateway:{auth:{token:secret+' invalid'}}}),
    JSON.stringify({gateway:{auth:{token:42}}}),
  ])('returns a generic error without echoing malformed or invalid private JSON',async(content)=>{
    const {controller,store,api}=await environment();
    await store.patch(record.id,{recipe:'openclaw'});
    api.read.mockResolvedValue(content);
    const error=await controller.appConnection(record.id).catch(error=>error);
    expect(error.message).toBe(unavailable);
    expect(String(error)).not.toContain(secret);
  });
  it('does not forward credential-bearing file-read failures',async()=>{
    const {controller,store,api}=await environment();
    await store.patch(record.id,{recipe:'openclaw'});
    api.read.mockRejectedValue(new Error(`Cannot read credential ${secret}`));
    const error=await controller.appConnection(record.id).catch(error=>error);
    expect(error.message).toBe(unavailable);
    expect(String(error)).not.toContain(secret);
  });
});

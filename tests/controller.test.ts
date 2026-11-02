import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Controller } from '../src/core/controller';
import { Store } from '../src/core/storage';
import { APIError, execURL, startDetached, SpritesAPI } from '../src/core/api';
import type { LaunchRecord, LaunchTarget } from '../src/core/types';
import type { Rules } from '../src/core/rules';
import type { GitHub } from '../src/core/github';

const target:LaunchTarget={owner:'acme',repo:'demo',kind:'branch',ref:'main',sha:'a'.repeat(40),cloneUrl:'https://github.com/acme/demo.git',fetchRef:'refs/heads/main',sourceUrl:'https://github.com/acme/demo'};
function memoryChrome() {
  const local:Record<string,unknown>={},session:Record<string,unknown>={};
  const area=(data:Record<string,unknown>)=>({setAccessLevel:vi.fn(async()=>{}),get:vi.fn(async(key:string|null)=>key===null?{...data}:{[key]:data[key]}),set:vi.fn(async(value:Record<string,unknown>)=>{Object.assign(data,value);}),remove:vi.fn(async(keys:string|string[])=>{for(const key of [keys].flat())delete data[key];})});
  return {storage:{local:area(local),session:area(session)},alarms:{create:vi.fn(),clear:vi.fn()},runtime:{id:'test',getURL:(path:string)=>`chrome-extension://test/${path}`},tabs:{create:vi.fn(async()=>({id:7})),update:vi.fn(),get:vi.fn()}};
}
function environment() {
  const store=new Store();
  const rules={terminal:vi.fn(async()=>{}),preview:vi.fn(async()=>{}),clear:vi.fn(async()=>{}),removeTab:vi.fn(async()=>{})} as unknown as Rules;
  const api={get:vi.fn(async(name:string)=>{const record=(await store.snapshot()).launches.find(r=>r.spriteName===name);if(record?.provisioned)return {name,id:'sprite-id',url:'https://demo-test.sprites.app'};throw new APIError(404);}),create:vi.fn(async(name:string)=>({name,id:'sprite-id',url:'https://demo-test.sprites.app'})),write:vi.fn(async(_name:string,_path:string,_data:string)=>{}),state:vi.fn(async()=>null),sessions:vi.fn(async()=>[]),remove:vi.fn(async()=>{}),read:vi.fn(),deleteFile:vi.fn(async()=>{}),fetch:vi.fn(async()=>new Response('{}'))};
  const github={resolve:vi.fn(async()=>({...target}))} as unknown as GitHub;
  const start=vi.fn(async(_url:string)=> '123');
  const controller=new Controller(store,rules,github,()=>api as unknown as SpritesAPI,'# bootstrap',start);
  return {controller,store,api,github,start,rules};
}
beforeEach(()=>{vi.stubGlobal('chrome',memoryChrome());});
describe('launch lifecycle',()=>{
  it('presents new and reused launches in the supplied progress panel without opening workspace tabs',async()=>{
    const {controller,store,api}=environment();
    await store.saveProfile({org:'test-org',token:'secret'});
    const present=vi.fn(async(_id?:string,_url?:string)=>{});
    const first=await controller.launch(target.sourceUrl,false,undefined,present);
    const reused=await controller.launch(target.sourceUrl,false,undefined,present);
    expect(reused.id).toBe(first.id);
    expect(present.mock.calls).toEqual([[first.id],[first.id]]);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(api.create).toHaveBeenCalledOnce();
  });
  it('presents sign-in in the same panel before provisioning when no organization is connected',async()=>{
    const {controller,api}=environment();
    const present=vi.fn(async(_id?:string,_url?:string)=>{});
    await expect(controller.launch(target.sourceUrl,false,undefined,present)).rejects.toThrow('Connect a Sprite organization first');
    expect(present).toHaveBeenCalledExactlyOnceWith(undefined,target.sourceUrl);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
  });
  it('persists ownership before provisioning and reuses the exact revision',async()=>{
    const {controller,store,api}=environment();
    await store.saveProfile({org:'test-org',token:'secret'});
    api.create.mockImplementation(async(name:string)=>{
      expect((await store.snapshot()).launches[0].spriteName).toBe(name);
      expect((await store.snapshot()).launches[0].provisioned).toBeUndefined();
      return {id:'sprite-id',name,url:'https://demo-test.sprites.app'};
    });
    const first=await controller.launch(target.sourceUrl);
    api.get.mockResolvedValue({id:'sprite-id',name:first.spriteName,url:first.url!} as never);
    const again=await controller.launch(target.sourceUrl);
    expect(first.id).toBe(again.id);
    expect(api.create).toHaveBeenCalledTimes(1);
  });
  it('reconciles an accepted creation whose response was lost',async()=>{
    const {controller,store,api}=environment();
    await store.saveProfile({org:'test-org',token:'secret'});
    api.create.mockRejectedValue(new Error('network disconnected'));
    api.get.mockImplementationOnce(async()=>{throw new APIError(404);}).mockImplementation(async(name:string)=>({id:'sprite-id',name,url:'https://demo-test.sprites.app'}) as never);
    const record=await controller.launch(target.sourceUrl);
    expect(record.provisioned).toBe(true);
    expect(record.phase).toBe('cloning');
    expect(api.create).toHaveBeenCalledTimes(1);
  });
  it('deduplicates simultaneous clicks and isolates a changed SHA',async()=>{
    const {controller,store,api,github}=environment();
    await store.saveProfile({org:'test-org',token:'secret'});
    const [one,two]=await Promise.all([controller.launch(target.sourceUrl),controller.launch(target.sourceUrl)]);
    expect(one.id).toBe(two.id);
    (github.resolve as ReturnType<typeof vi.fn>).mockResolvedValue({...target,sha:'b'.repeat(40)});
    const changed=await controller.launch(target.sourceUrl);
    expect(changed.id).not.toBe(one.id);
    expect(api.create).toHaveBeenCalledTimes(2);
  });
  it('never provisions if GitHub lookup fails',async()=>{
    const {controller,store,api,github}=environment();
    await store.saveProfile({org:'test-org',token:'secret'});
    (github.resolve as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('private repo'));
    await expect(controller.launch(target.sourceUrl)).rejects.toThrow('private repo');
    expect(api.create).not.toHaveBeenCalled();
  });
  it('uploads no management credential to the Sprite and uses detachable setup',async()=>{
    const {controller,store,api,start}=environment();
    await store.saveProfile({org:'test-org',token:'management-secret'});
    await controller.launch(target.sourceUrl);
    expect(JSON.stringify(api.write.mock.calls)).not.toContain('management-secret');
    expect(new URL(start.mock.calls[0][0]).searchParams.get('max_run_after_disconnect')).toBe('25m');
  });
  it('retains workspace on cancellation and deletes only explicitly requested launch',async()=>{
    const {controller,store,api}=environment();
    await store.saveProfile({org:'test-org',token:'secret'});
    const record=await controller.launch(target.sourceUrl);
    expect((await controller.cancel(record.id)).phase).toBe('cancelled');
    expect(api.remove).not.toHaveBeenCalled();
    expect(api.write.mock.calls.some(call=>String(call[1]).endsWith('/cancel'))).toBe(true);
    await controller.delete(record.id);
    expect(api.remove).toHaveBeenCalledWith(record.spriteName);
    expect((await store.snapshot()).launches).toHaveLength(0);
  });
  it('recovers persisted remote progress without starting setup again',async()=>{
    const {controller,store,api,start}=environment();
    await store.saveProfile({org:'test-org',token:'secret'});
    const record=await controller.launch(target.sourceUrl);
    api.state.mockResolvedValue({phase:'installing',attemptId:record.attemptId,setupPid:123} as never);
    expect((await controller.refresh(record.id)).phase).toBe('installing');
    expect(start).toHaveBeenCalledTimes(1);
  });
  it('waits for in-flight creation before deleting and dropping ownership',async()=>{
    const {controller,store,api}=environment();
    await store.saveProfile({org:'test-org',token:'secret'});
    let resolveCreate!:(sprite:{id:string;name:string;url:string})=>void;
    api.create.mockImplementation((name:string)=>new Promise(resolve=>{resolveCreate=resolve;}));
    const creating=controller.launch(target.sourceUrl);
    await vi.waitFor(()=>expect(api.create).toHaveBeenCalledOnce());
    const record=(await store.snapshot()).launches[0];
    const deleting=controller.delete(record.id);
    expect(api.remove).not.toHaveBeenCalled();
    resolveCreate({id:'sprite-id',name:record.spriteName,url:'https://demo-test.sprites.app'});
    await creating;
    await deleting;
    expect(api.remove).toHaveBeenCalledWith(record.spriteName);
    expect((await store.snapshot()).launches).toHaveLength(0);
  });
  it('stops background polling of stale jobs whose remote process died',async()=>{
    const {controller,store,api}=environment();
    await store.saveProfile({org:'test-org',token:'secret'});
    const record=await controller.launch(target.sourceUrl);
    await store.patch(record.id,{setupStartedAt:new Date(Date.now()-26*60000).toISOString()});
    api.state.mockResolvedValue({phase:'installing',attemptId:record.attemptId} as never);
    expect((await controller.refresh(record.id)).phase).toBe('failed');
  });
  it('retains an unacknowledged creation when a restarted worker receives another click',async()=>{
    const {controller,store,api,rules,github,start}=environment();
    await store.saveProfile({org:'test-org',token:'secret'});
    let finish!:(sprite:{id:string;name:string;url:string})=>void;
    api.create.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const first=controller.launch(target.sourceUrl);
    await vi.waitFor(()=>expect(api.create).toHaveBeenCalledOnce());
    const pending=(await store.snapshot()).launches[0];
    const restarted=new Controller(store,rules,github,()=>api as unknown as SpritesAPI,'# bootstrap',start);
    const second=await restarted.launch(target.sourceUrl);
    expect(second.id).toBe(pending.id);
    expect(api.create).toHaveBeenCalledTimes(1);
    finish({id:'sprite-id',name:pending.spriteName,url:'https://demo-test.sprites.app'});
    await first;
  });
  it('refuses to delete a different Sprite recreated under an old launch name',async()=>{
    const {controller,store,api}=environment();
    await store.saveProfile({org:'test-org',token:'secret'});
    const record=await controller.launch(target.sourceUrl);
    api.get.mockResolvedValue({id:'someone-else',name:record.spriteName,url:'https://different.sprites.app'});
    await expect(controller.delete(record.id)).rejects.toThrow(/different Sprite/);
    expect(api.remove).not.toHaveBeenCalled();
    expect((await store.snapshot()).launches).toHaveLength(1);
  });
  it('bounds automatic setup retries without resetting their original deadline',async()=>{
    const {controller,store,start}=environment();
    await store.saveProfile({org:'test-org',token:'secret'});
    start.mockRejectedValue(new Error('No acknowledgement'));
    const first=await controller.launch(target.sourceUrl);
    await expect(controller.refresh(first.id)).rejects.toThrow('No acknowledgement');
    await expect(controller.refresh(first.id)).rejects.toThrow('No acknowledgement');
    const final=await controller.refresh(first.id);
    expect(final.phase).toBe('failed');
    expect(final.setupStartedAt).toBe(first.setupStartedAt);
    expect(start).toHaveBeenCalledTimes(3);
  });
  it('ignores a prior attempt result after an explicit retry',async()=>{
    const {controller,store,api}=environment();
    await store.saveProfile({org:'test-org',token:'secret'});
    const old=await controller.launch(target.sourceUrl);
    await store.patch(old.id,{phase:'failed'});
    const retry=await controller.retry(old.id);
    expect(retry.attemptId).not.toBe(old.attemptId);
    api.state.mockResolvedValue({phase:'ready',attemptId:old.attemptId} as never);
    api.sessions.mockResolvedValue([{id:'123',command:'python3'}] as never);
    expect((await controller.refresh(old.id)).phase).toBe('cloning');
  });
});
describe('exec transport',()=>{
  it('resumes an existing terminal but starts a fresh shell with the current launch context on request',async()=>{
    const {controller,store,api}=environment();
    await store.saveProfile({org:'test-org',token:'secret'});
    const record=await controller.launch(target.sourceUrl);
    await store.patch(record.id,{terminalSessionId:'456'});
    api.sessions.mockResolvedValue([{id:'456',command:'bash',tty:true}] as never);
    const resumed=new URL((await controller.handle({type:'terminal',id:record.id,cols:90,rows:30}) as {url:string}).url);
    expect(resumed.pathname).toBe(`/v1/sprites/${record.spriteName}/exec/456`);
    expect(resumed.searchParams.getAll('cmd')).toEqual([]);
    api.sessions.mockClear();
    const fresh=new URL((await controller.handle({type:'terminal',id:record.id,cols:90,rows:30,fresh:true}) as {url:string}).url);
    expect(fresh.pathname).toBe(`/v1/sprites/${record.spriteName}/exec`);
    expect(fresh.searchParams.getAll('cmd')).toEqual(expect.arrayContaining(['bash',`/home/sprite/.sprite-launch/${record.id}/terminal-rc.sh`]));
    expect(api.sessions).not.toHaveBeenCalled();
    expect((await store.record(record.id)).terminalSessionId).toBe('456');
  });
  it('keeps tokens out of URLs and sets TTY reconnect options',()=>{
    const url=new URL(execURL('test-sprite',[],{tty:true,sessionId:'123',disconnect:'0'}));
    expect(url.pathname).toBe('/v1/sprites/test-sprite/exec/123');
    expect(url.searchParams.get('max_run_after_disconnect')).toBe('0');
    expect(url.searchParams.has('token')).toBe(false);
  });
  it('waits for session acknowledgement before detaching',async()=>{
    let socket:any;
    class Socket {onmessage:any;onerror:any;onclose:any;close=vi.fn();constructor(){socket=this;}}
    const promise=startDetached('wss://example.test',Socket as unknown as typeof WebSocket);
    expect(socket.close).not.toHaveBeenCalled();
    socket.onmessage({data:JSON.stringify({type:'session_info',session_id:'123'})});
    await expect(promise).resolves.toBe('123');
    expect(socket.close).toHaveBeenCalled();
  });
});

describe('app connection credentials',()=>{
  it('retrieves an OpenClaw token only on demand and keeps it out of snapshots',async()=>{
    const {controller,store,api}=environment();
    await store.saveProfile({org:'test-org',token:'management-secret'});
    const launch=await controller.launch(target.sourceUrl);
    await store.patch(launch.id,{phase:'ready',recipe:'openclaw'});
    const token='a'.repeat(48);
    api.read.mockResolvedValue(JSON.stringify({gateway:{auth:{mode:'token',token}}}));
    expect(api.read).not.toHaveBeenCalled();
    await expect(controller.appConnection(launch.id)).resolves.toEqual({token});
    expect(api.read).toHaveBeenCalledWith(launch.spriteName,`/home/sprite/.sprite-launch/${launch.id}/openclaw.json`);
    expect(JSON.stringify(await store.snapshot())).not.toContain(token);
    await store.patch(launch.id,{recipe:'vite'});
    await expect(controller.appConnection(launch.id)).rejects.toThrow(/no app connection/);
  });
});

describe('Hermes dashboard credentials',()=>{
  const username='sprite';
  const password='private-hermes-fixture-password-'.repeat(2);
  const unavailable='Hermes sign-in configuration is unavailable.';

  async function readyHermes() {
    const env=environment();
    await env.store.saveProfile({org:'test-org',token:'management-secret'});
    const launch=await env.controller.launch(target.sourceUrl);
    await env.store.patch(launch.id,{phase:'ready',recipe:'hermes'});
    env.api.get.mockClear();
    env.api.read.mockResolvedValue(JSON.stringify({username,password}));
    return {...env,launch};
  }

  it('reads only on demand from the fixed private file after checking Sprite ownership, without persisting credentials',async()=>{
    const {controller,store,api,launch}=await readyHermes();
    expect(api.read).not.toHaveBeenCalled();
    expect(JSON.stringify(await controller.handle({type:'snapshot'}))).not.toContain(password);
    expect(api.read).not.toHaveBeenCalled();
    await expect(controller.handle({type:'hermes_connection',id:launch.id})).resolves.toEqual({username,password});
    expect(api.get).toHaveBeenCalledExactlyOnceWith(launch.spriteName);
    expect(api.read).toHaveBeenCalledExactlyOnceWith(launch.spriteName,`/home/sprite/.sprite-launch/${launch.id}/hermes-connection.json`);
    expect(api.get.mock.invocationCallOrder[0]).toBeLessThan(api.read.mock.invocationCallOrder[0]);
    expect(JSON.stringify(await store.snapshot())).not.toContain(password);
    expect(JSON.stringify(await store.read())).not.toContain(password);
    expect(JSON.stringify(api.write.mock.calls)).not.toContain(password);
  });

  it.each([
    'queued','creating','cloning','detecting','installing','database','starting','needs_configuration','failed','cancelled',
  ] as const)('does not read credentials for a Hermes launch in phase %s',async(phase)=>{
    const {controller,store,api,launch}=await readyHermes();
    await store.patch(launch.id,{phase});
    await expect(controller.hermesConnection(launch.id)).rejects.toThrow('This launch has no Hermes sign-in details.');
    expect(api.get).not.toHaveBeenCalled();
    expect(api.read).not.toHaveBeenCalled();
  });

  it.each(['vite','openclaw',undefined])('does not read Hermes credentials for a ready %s launch',async(recipe)=>{
    const {controller,store,api,launch}=await readyHermes();
    await store.patch(launch.id,{recipe});
    await expect(controller.hermesConnection(launch.id)).rejects.toThrow('This launch has no Hermes sign-in details.');
    expect(api.get).not.toHaveBeenCalled();
    expect(api.read).not.toHaveBeenCalled();
  });

  it('uses the owning launch organization even when another organization is selected',async()=>{
    const {store,api,rules,github,start,launch}=await readyHermes();
    await store.saveProfile({org:'another-org',token:'another-management-secret'});
    const apiFactory=vi.fn(()=>api as unknown as SpritesAPI);
    const controller=new Controller(store,rules,github,apiFactory,'# bootstrap',start);
    await expect(controller.hermesConnection(launch.id)).resolves.toEqual({username,password});
    expect(apiFactory).toHaveBeenCalledExactlyOnceWith({org:'test-org',token:'management-secret'});
    expect(api.get).toHaveBeenCalledExactlyOnceWith(launch.spriteName);
  });

  it('requires credentials for the owning organization and never falls back to another signed-in organization',async()=>{
    const {controller,store,api,launch}=await readyHermes();
    await store.saveProfile({org:'another-org',token:'another-management-secret'});
    await store.logout('test-org');
    await expect(controller.hermesConnection(launch.id)).rejects.toThrow('Connect a Sprite organization first.');
    expect(api.get).not.toHaveBeenCalled();
    expect(api.read).not.toHaveBeenCalled();
  });

  it.each([
    {id:'recreated-sprite',name:'same',url:'https://demo-test.sprites.app'},
    {id:'sprite-id',name:'different-sprite',url:'https://demo-test.sprites.app'},
    {id:'',name:'same',url:'https://demo-test.sprites.app'},
  ])('refuses to read from a Sprite whose ownership response changed: %o',async(sprite)=>{
    const {controller,api,launch}=await readyHermes();
    api.get.mockResolvedValue({...sprite,name:sprite.name==='same'?launch.spriteName:sprite.name});
    await expect(controller.hermesConnection(launch.id)).rejects.toThrow();
    expect(api.read).not.toHaveBeenCalled();
  });

  it.each([
    `{"username":"sprite","password":"${password}"`,
    JSON.stringify(null),
    JSON.stringify([]),
    JSON.stringify(password),
    JSON.stringify({password}),
    JSON.stringify({username,password:32}),
    JSON.stringify({username:32,password}),
    JSON.stringify({username:'',password}),
    JSON.stringify({username:'outside/user',password}),
    JSON.stringify({username:'x'.repeat(65),password}),
    JSON.stringify({username,password:''}),
    JSON.stringify({username,password:'short'}),
    JSON.stringify({username,password:'x'.repeat(129)}),
    JSON.stringify({username,password:`${password} invalid`}),
  ])('returns a generic error for malformed or invalid private content without echoing it',async(content)=>{
    const {controller,api,launch}=await readyHermes();
    api.read.mockResolvedValue(content);
    const result=await controller.hermesConnection(launch.id).catch((error:Error)=>error);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe(unavailable);
    expect(String(result)).not.toContain(password);
  });

  it.each([
    new Error(`Read failed for credential ${password}`),
    new APIError(404),
  ])('returns a generic error for private file read failures',async(error)=>{
    const {controller,api,launch}=await readyHermes();
    api.read.mockRejectedValue(error);
    const result=await controller.hermesConnection(launch.id).catch((failure:Error)=>failure);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe(unavailable);
    expect(String(result)).not.toContain(password);
  });
});

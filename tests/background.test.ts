import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture=vi.hoisted(()=>({
  initialize:vi.fn(),launch:vi.fn(),handle:vi.fn(),safeError:vi.fn(async(error:Error)=>error.message),
}));
vi.mock('../src/core/controller',()=>({Controller:class {
  store={initialize:fixture.initialize,safeError:fixture.safeError};
  launch=fixture.launch;handle=fixture.handle;
  rules={removeTab:vi.fn()};recover=vi.fn();rebuildRules=vi.fn();
}}));

type Listener=(message:unknown,sender:chrome.runtime.MessageSender,respond:(value:unknown)=>void)=>boolean;
let listener:Listener;
let values:Record<string,unknown>;
let open:ReturnType<typeof vi.fn>;
const record={id:'a'.repeat(36),phase:'installing',org:'private-org',overrides:{startCommand:'APP_PASSWORD=private-value npm start'}};
const sender={id:'self',url:'https://github.com/acme/demo',frameId:0,tab:{id:3,windowId:7}} as chrome.runtime.MessageSender;
beforeEach(()=>{
  vi.resetModules();vi.clearAllMocks();values={};
  fixture.initialize.mockResolvedValue(undefined);
  fixture.safeError.mockImplementation(async(error:Error)=>error.message);
  fixture.launch.mockImplementation(async(_url:string,_force?:boolean,_ref?:string,present?:(id:string)=>Promise<void>)=>{await present?.(record.id);return record;});
  fixture.handle.mockResolvedValue(record);
  open=vi.fn(async()=>{});
  const event={addListener:vi.fn()};
  vi.stubGlobal('chrome',{
    runtime:{id:'self',getURL:(path:string)=>`chrome-extension://self/${path}`,onConnect:event,onMessage:{addListener:(fn:Listener)=>{listener=fn;}},onStartup:event,onInstalled:event},
    action:{onClicked:event},tabs:{onRemoved:event,onUpdated:event},windows:{onRemoved:event},alarms:{onAlarm:event},sidePanel:{open},
    storage:{session:{get:vi.fn(async(key:string)=>({[key]:values[key]})),set:vi.fn(async(data:Record<string,unknown>)=>{Object.assign(values,data);}),remove:vi.fn()}},
  });
});

describe('GitHub launch to isolated progress panel',()=>{
  it('opens during the click before asynchronous storage initialization, and acknowledges with no private record fields',async()=>{
    let initialize!:()=>void;
    fixture.initialize.mockReturnValue(new Promise<void>(resolve=>{initialize=resolve;}));
    await import('../src/background');
    const respond=vi.fn();
    expect(listener({type:'launch',url:sender.url},sender,respond)).toBe(true);
    expect(open).toHaveBeenCalledExactlyOnceWith({windowId:7});
    expect(fixture.launch).not.toHaveBeenCalled();
    initialize();
    await vi.waitFor(()=>expect(respond).toHaveBeenCalled());
    expect(respond).toHaveBeenCalledWith({ok:true,data:{id:record.id,phase:record.phase}});
    expect(JSON.stringify(respond.mock.calls)).not.toContain('private');
    expect(values['launchPanel:7']).toMatchObject({stage:'launch',launchId:record.id,sourceUrl:sender.url});
    expect(fixture.handle).not.toHaveBeenCalled();
  });
  it('falls back to the existing workspace-tab flow if the panel is unavailable',async()=>{
    open.mockRejectedValue(new Error('Unavailable'));
    await import('../src/background');
    const respond=vi.fn();listener({type:'launch',url:sender.url},sender,respond);
    await vi.waitFor(()=>expect(respond).toHaveBeenCalled());
    expect(fixture.handle).toHaveBeenCalledWith({type:'launch',url:sender.url});
    expect(fixture.launch).not.toHaveBeenCalled();
    expect(values).toEqual({});
  });
  it.each([
    {request:{type:'snapshot'},sender},
    {request:{type:'launch',url:sender.url,panelWindowId:8},sender},
    {request:{type:'launch',url:sender.url},sender:{...sender,frameId:2}},
    {request:{type:'launch',url:'https://github.com/acme/other'},sender},
  ])('never opens or provisions for rejected page requests: %o',async(value)=>{
    await import('../src/background');
    const respond=vi.fn();expect(listener(value.request,value.sender,respond)).toBe(false);
    expect(respond).toHaveBeenCalledWith({ok:false,error:'This action is not available from this page.'});
    expect(open).not.toHaveBeenCalled();expect(fixture.launch).not.toHaveBeenCalled();expect(fixture.handle).not.toHaveBeenCalled();
  });
  it('routes a trusted panel launch back to its own progress view without another open call',async()=>{
    await import('../src/background');
    const respond=vi.fn();
    listener({type:'launch',url:sender.url,panelWindowId:7},{id:'self',url:'chrome-extension://self/index.html?panel=1'},respond);
    await vi.waitFor(()=>expect(respond).toHaveBeenCalled());
    expect(open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({ok:true,data:record});
    expect(values['launchPanel:7']).toMatchObject({stage:'launch',launchId:record.id});
  });
  it('shows failure details only inside the extension and gives GitHub a generic error',async()=>{
    fixture.launch.mockRejectedValue(new Error('Private configuration details'));
    await import('../src/background');
    const respond=vi.fn();listener({type:'launch',url:sender.url},sender,respond);
    await vi.waitFor(()=>expect(respond).toHaveBeenCalled());
    expect(respond).toHaveBeenCalledWith({ok:false,error:'Launch could not be started. Open the extension to see details.'});
    expect(values['launchPanel:7']).toMatchObject({stage:'error',error:'Private configuration details'});
  });
});

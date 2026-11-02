import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentExec } from '../src/core/document-exec';

function port(url='chrome-extension://self/index.html?launch=test') {
  const messages:((value:unknown)=>void)[]=[],disconnects:(()=>void)[]=[];
  const value={name:'sprite-setup-exec',sender:{id:'self',url},disconnect:vi.fn(),postMessage:vi.fn(),onMessage:{addListener:(fn:(message:unknown)=>void)=>messages.push(fn)},onDisconnect:{addListener:(fn:()=>void)=>disconnects.push(fn)}};
  return {value:value as unknown as chrome.runtime.Port,messages,disconnects};
}
beforeEach(()=>{vi.stubGlobal('chrome',{runtime:{id:'self',getURL:(path:string)=>`chrome-extension://self/${path}`},tabs:{create:vi.fn()}});});
describe('trusted document setup broker',()=>{
  it('rejects ports from GitHub content scripts',()=>{
    const broker=new DocumentExec(),script=port('https://github.com/acme/repo');
    broker.connect(script.value);
    expect(script.value.disconnect).toHaveBeenCalledOnce();
  });
  it('accepts an acknowledgement only from the document receiving the request',async()=>{
    const broker=new DocumentExec(),one=port(),two=port();
    broker.connect(one.value);broker.connect(two.value);
    const operation=broker.start('wss://api.sprites.dev/v1/sprites/demo/exec?cmd=python3');
    await vi.waitFor(()=>expect(one.value.postMessage).toHaveBeenCalledOnce());
    const request=(one.value.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    two.messages[0]({requestId:request.requestId,sessionId:'999'});
    one.messages[0]({requestId:request.requestId,sessionId:'123'});
    await expect(operation).resolves.toBe('123');
    expect(request.url).not.toMatch(/token|secret|Authorization/);
  });
  it('rejects a disconnected acknowledgement and unsafe destinations',async()=>{
    const broker=new DocumentExec(),doc=port();broker.connect(doc.value);
    await expect(broker.start('wss://evil.test/v1/sprites/demo/exec')).rejects.toThrow('Untrusted');
    const pending=broker.start('wss://api.sprites.dev/v1/sprites/demo/exec?cmd=python3');
    await vi.waitFor(()=>expect(doc.value.postMessage).toHaveBeenCalledOnce());
    doc.disconnects[0]();
    await expect(pending).rejects.toThrow(/closed/);
  });
});

export interface PanelBinding {
  nonce:string;
  sourceUrl?:string;
  launchId?:string;
  stage:'resolving'|'login'|'launch'|'error'|'idle';
  error?:string;
}
export interface PanelIntent {
  activate():Promise<void>;
  present(id?:string,sourceUrl?:string):Promise<void>;
  fail(error:string):Promise<void>;
}

/** Window-scoped progress lives only in trusted extension session storage. */
export class Panels {
  private latest=new Map<number,string>();
  private queues=new Map<number,Promise<unknown>>();
  open(windowId:number):Promise<boolean> {
    // Keep this call synchronous with the click/message event. Awaiting storage
    // or GitHub first loses Chrome's transient user activation.
    try { return chrome.sidePanel.open({windowId}).then(()=>true,()=>false); }
    catch { return Promise.resolve(false); }
  }
  intent(windowId:number,sourceUrl?:string):PanelIntent {
    const nonce=crypto.randomUUID();
    this.latest.set(windowId,nonce);
    const key=`launchPanel:${windowId}`;
    const write=(update:(old:PanelBinding|undefined)=>PanelBinding)=>{
      const prior=this.queues.get(windowId)??Promise.resolve();
      const operation=prior.catch(()=>undefined).then(async()=>{
        if(this.latest.get(windowId)!==nonce)return;
        const old=(await chrome.storage.session.get(key))[key] as PanelBinding|undefined;
        if(this.latest.get(windowId)!==nonce)return;
        await chrome.storage.session.set({[key]:update(old)});
      });
      this.queues.set(windowId,operation);
      void operation.finally(()=>{if(this.queues.get(windowId)===operation)this.queues.delete(windowId);}).catch(()=>undefined);
      return operation;
    };
    return {
      activate:()=>write(()=>({nonce,sourceUrl,stage:sourceUrl?'resolving':'idle'})),
      present:(launchId,url)=>write(()=>({nonce,sourceUrl:url??sourceUrl,launchId,stage:launchId?'launch':'login'})),
      fail:error=>write(old=>({...old,nonce,sourceUrl:old?.sourceUrl??sourceUrl,stage:old?.stage==='login'?'login':'error',error})),
    };
  }
  async removeWindow(windowId:number) {
    this.latest.delete(windowId);
    await this.queues.get(windowId)?.catch(()=>undefined);
    await chrome.storage.session.remove(`launchPanel:${windowId}`);
  }
}

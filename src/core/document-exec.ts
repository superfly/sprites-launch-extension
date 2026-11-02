/**
 * Chromium does not consistently apply DNR header rules to WebSockets opened
 * by an extension service worker. A trusted extension document owns the brief
 * session handshake instead; only its token-free URL crosses this port.
 */
export class DocumentExec {
  private ports=new Set<chrome.runtime.Port>();
  private listeners=new Set<()=>void>();
  private pending=new Map<string,{port:chrome.runtime.Port;resolve:(id:string)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  connect(port:chrome.runtime.Port) {
    if(port.name!=='sprite-setup-exec'||port.sender?.id!==chrome.runtime.id||port.sender.url!==chrome.runtime.getURL('index.html')&&!port.sender.url?.startsWith(chrome.runtime.getURL('index.html')+'?')){
      port.disconnect();return;
    }
    this.ports.add(port);
    for(const listener of this.listeners)listener();
    port.onMessage.addListener((message:unknown)=>{
      if(!message||typeof message!=='object')return;
      const value=message as {requestId?:string;sessionId?:string;error?:string};
      if(!value.requestId)return;
      const request=this.pending.get(value.requestId);
      if(!request||request.port!==port)return;
      clearTimeout(request.timer);this.pending.delete(value.requestId);
      if(typeof value.sessionId==='string'&&/^\d+$/.test(value.sessionId))request.resolve(value.sessionId);
      else request.reject(new Error(typeof value.error==='string'?value.error.slice(0,1000):'Setup handshake failed.'));
    });
    port.onDisconnect.addListener(()=>{
      this.ports.delete(port);
      for(const [id,request] of this.pending)if(request.port===port){clearTimeout(request.timer);this.pending.delete(id);request.reject(new Error('The launch page closed during setup acknowledgement. Reopen it to reconcile progress.'));}
    });
  }
  private wait():Promise<chrome.runtime.Port> {
    const existing=this.ports.values().next().value;
    if(existing)return Promise.resolve(existing);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.listeners.delete(connected);reject(new Error('Open the launch page to continue setup.'));},10000);
      const connected=()=>{const port=this.ports.values().next().value;if(port){clearTimeout(timer);this.listeners.delete(connected);resolve(port);}};
      this.listeners.add(connected);
    });
  }
  async start(url:string,launchId?:string):Promise<string> {
    const parsed=new URL(url);
    if(parsed.origin!=='wss://api.sprites.dev'||!/^\/v1\/sprites\/[a-z\d-]+\/exec$/.test(parsed.pathname)||parsed.username||parsed.password)throw new Error('Untrusted setup connection.');
    // The normal flow has already opened its launch tab. Wait briefly for that
    // document; after a worker/browser restart, reopen one inactive recovery tab.
    const reopen=setTimeout(()=>{if(!this.ports.size){const page=new URL(chrome.runtime.getURL('index.html'));if(launchId)page.searchParams.set('launch',launchId);void chrome.tabs.create({url:page.href,active:false});}},1500);
    let port:chrome.runtime.Port;
    try{port=await this.wait();}finally{clearTimeout(reopen);}
    const requestId=crypto.randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(requestId);reject(new Error('Setup did not acknowledge its remote session. Reopen this launch to reconcile it.'));},25000);
      this.pending.set(requestId,{port,resolve,reject,timer});
      try{port.postMessage({requestId,url});}catch{clearTimeout(timer);this.pending.delete(requestId);reject(new Error('The launch page disconnected. Reopen it to continue setup.'));}
    });
  }
}

import { API_ORIGIN, launchDirectory, type LaunchRecord, type Profile, type RemoteState } from './types';
import { previewHostname } from './security';
export class APIError extends Error { constructor(public status:number) {super(`Sprites API request failed (HTTP ${status}).${status===401?' Reconnect your organization.':''}`);} }
export interface SpriteInfo {id:string;name:string;url:string;url_settings?:{auth:string}|null}
export class SpritesAPI {
  constructor(private profile:Profile,private request:typeof fetch=globalThis.fetch.bind(globalThis)) {}
  async fetch(path:string,init:RequestInit={}):Promise<Response> {
    const response=await this.request(`${API_ORIGIN}${path}`,{...init,headers:{Authorization:`Bearer ${this.profile.token}`,...init.headers},credentials:'omit',redirect:'error',signal:init.signal ?? AbortSignal.timeout(25000)});
    if(!response.ok)throw new APIError(response.status);
    return response;
  }
  spritePath(name:string) {return `/v1/sprites/${encodeURIComponent(name)}`;}
  async get(name:string):Promise<SpriteInfo> {return (await this.fetch(this.spritePath(name))).json();}
  async create(name:string):Promise<SpriteInfo> {
    return (await this.fetch('/v1/sprites',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,url_settings:{auth:'sprite'}})})).json();
  }
  async remove(name:string) {await this.fetch(this.spritePath(name),{method:'DELETE'});}
  private fs(name:string,operation:string,path:string) {
    const params=new URLSearchParams({path,workingDir:'/home/sprite'});
    return `${this.spritePath(name)}/fs/${operation}?${params}`;
  }
  async write(name:string,path:string,data:string) {
    await this.fetch(`${this.fs(name,'write',path)}&mkdirParents=true&mode=0600`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:data});
  }
  async read(name:string,path:string,tail=false):Promise<string> {
    const response=await this.fetch(this.fs(name,'read',path),tail?{headers:{Range:'bytes=-65536'}}:{});
    return response.text();
  }
  async deleteFile(name:string,path:string) {
    try {await this.fetch(`${this.spritePath(name)}/fs/delete`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({path,workingDir:'/home/sprite'})});}
    catch(e) {if(!(e instanceof APIError) || e.status!==404)throw e;}
  }
  async state(record:LaunchRecord):Promise<RemoteState|null> {
    try {return JSON.parse(await this.read(record.spriteName,`${launchDirectory(record.id)}/state.json`));}
    catch(e) {if(e instanceof APIError && e.status===404)return null;throw e;}
  }
  async sessions(name:string):Promise<{id:string;command:string;tty?:boolean}[]> {
    const data=await (await this.fetch(`${this.spritePath(name)}/exec`)).json();
    return data.sessions ?? [];
  }
  async kill(name:string,sessionId:string) {
    if(!/^\d+$/.test(sessionId))throw new Error('Invalid session ID.');
    const response=await this.fetch(`${this.spritePath(name)}/exec/${sessionId}/kill?signal=SIGTERM&timeout=5s`,{method:'POST'});
    await response.text();
  }
  static checkedSprite(sprite:SpriteInfo,name:string) {
    if(sprite.name!==name || !sprite.id)throw new Error('Sprite response does not match the launch.');
    previewHostname(sprite.url);
    return sprite;
  }
}
export function execURL(name:string,command:string[],options:{tty?:boolean;cols?:number;rows?:number;sessionId?:string;dir?:string;disconnect?:string}={}) {
  const url=new URL(`${API_ORIGIN.replace('https:','wss:')}/v1/sprites/${encodeURIComponent(name)}/exec${options.sessionId?`/${encodeURIComponent(options.sessionId)}`:''}`);
  for(const arg of command)url.searchParams.append('cmd',arg);
  if(options.tty) {url.searchParams.set('tty','true');url.searchParams.set('stdin','true');url.searchParams.set('cols',String(options.cols??80));url.searchParams.set('rows',String(options.rows??24));}
  if(options.dir)url.searchParams.set('dir',options.dir);
  url.searchParams.set('max_run_after_disconnect',options.disconnect??'25m');
  return url.href;
}
/** Close after the server acknowledges a persisted session; work continues remotely. */
export function startDetached(url:string,Socket:typeof WebSocket=WebSocket):Promise<string> {
  return new Promise((resolve,reject)=>{
    const socket=new Socket(url);
    let settled=false;
    const finish=(error?:Error,id?:string)=>{if(settled)return;settled=true;clearTimeout(timeout);socket.close();if(error)reject(error);else resolve(id!);};
    const timeout=setTimeout(()=>finish(new Error('Setup connection timed out. Reopen this launch to reconcile its remote state.')),20000);
    socket.onmessage=event=>{
      if(typeof event.data!=='string')return;
      try {const info=JSON.parse(event.data);if(info.type==='session_info' && /^\d+$/.test(String(info.session_id)))finish(undefined,String(info.session_id));else if(info.error)finish(new Error('Sprite could not start the setup session.'));}catch{/* Ignore non-control output. */}
    };
    socket.onerror=()=>finish(new Error('Setup connection failed. Its remote state will be checked before retry.'));
    socket.onclose=()=>{if(!settled)finish(new Error('Setup connection closed before acknowledgement. Reopen this launch to reconcile it.'));};
  });
}

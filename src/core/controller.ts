import { APIError, execURL, SpritesAPI, startDetached } from './api';
import { GitHub } from './github';
import { Rules } from './rules';
import { PREVIEW_AUTH_VERIFIED, Store } from './storage';
import { previewHostname, validateOverrides } from './security';
import { API_ORIGIN, launchDirectory, type LaunchOverrides, type LaunchRecord, type Profile, type RemoteState, type Request } from './types';

const FINAL_PHASES=new Set(['ready','needs_configuration','failed','cancelled']);
const REMOTE_PHASES=new Set(['cloning','detecting','installing','database','starting','ready','needs_configuration','failed','cancelled']);
export class Controller {
  private locks=new Map<string,Promise<unknown>>();
  private mutationQueues=new Map<string,Promise<unknown>>();
  constructor(
    readonly store=new Store(),
    readonly rules=new Rules(),
    private readonly github=new GitHub(),
    private readonly apiFactory=(profile:Profile)=>new SpritesAPI(profile),
    private readonly bootstrap:string='',
    private readonly start:(url:string,launchId?:string)=>Promise<string>=(url)=>startDetached(url),
  ) {}
  private async locked<T>(key:string,fn:()=>Promise<T>):Promise<T> {
    const existing=this.locks.get(key);if(existing)return existing as Promise<T>;
    const work=fn();this.locks.set(key,work);
    try{return await work;}finally{if(this.locks.get(key)===work)this.locks.delete(key);}
  }
  private async mutate<T>(id:string,fn:()=>Promise<T>):Promise<T> {
    const prior=this.mutationQueues.get(id)??Promise.resolve();
    const work=prior.catch(()=>undefined).then(fn);
    this.mutationQueues.set(id,work);
    try{return await work;}finally{if(this.mutationQueues.get(id)===work)this.mutationQueues.delete(id);}
  }
  private async openUI(id?:string,url?:string) {
    const target=new URL(chrome.runtime.getURL('index.html'));
    if(id)target.searchParams.set('launch',id);
    if(url)target.searchParams.set('url',url);
    await chrome.tabs.create({url:target.href});
  }
  async launch(url:string,forceNew=false,refHint?:string,present?:(id?:string,url?:string)=>Promise<void>) {
    const show=present??((id?:string,source?:string)=>this.openUI(id,source));
    let profile:Profile;
    try{profile=await this.store.profile();}catch(e){await show(undefined,url);throw e;}
    const target=await this.github.resolve(url,refHint);
    const key=`${profile.org}:${target.owner.toLowerCase()}/${target.repo.toLowerCase()}:${target.sha}`;
    return this.locked(key,async()=>{
      const snapshot=await this.store.snapshot();
      if(!forceNew){
        const existing=snapshot.launches.find(r=>r.org===profile.org && r.target.owner.toLowerCase()===target.owner.toLowerCase() && r.target.repo.toLowerCase()===target.repo.toLowerCase() && r.target.sha===target.sha);
        if(existing){
          if(!existing.provisioned){
            await show(existing.id);
            await chrome.alarms.create('launch-recovery',{periodInMinutes:0.5});
            return existing;
          }
          const api=this.apiFactory(profile);
          try{this.assertIdentity(existing,await api.get(existing.spriteName));await show(existing.id);return existing;}
          catch(e){if(!(e instanceof APIError) || e.status!==404)throw e;await this.store.remove(existing.id);}
        }
      }
      const id=crypto.randomUUID();
      const slug=target.repo.toLowerCase().replace(/[^a-z\d-]/g,'-').slice(0,24).replace(/^-+|-+$/g,'')||'repo';
      const now=new Date().toISOString();
      const record:LaunchRecord={id,attemptId:crypto.randomUUID(),org:profile.org,target,spriteName:`gh-${slug}-${id.slice(0,8)}`,phase:'queued',createdAt:now,updatedAt:now,overrides:await this.store.overrides(`${target.owner}/${target.repo}`)};
      await this.store.save(record);
      await chrome.alarms.create('launch-recovery',{periodInMinutes:0.5});
      await show(id);
      // A persisted record/name precedes every remote mutation; recovery can reconcile a suspended worker.
      try{return await this.mutate(id,()=>this.provision(record));}catch(e){return this.store.patch(id,{message:await this.store.safeError(e)});}
    });
  }
  private assertIdentity(record:LaunchRecord,sprite:{id:string;name:string;url:string}) {
    SpritesAPI.checkedSprite(sprite,record.spriteName);
    if(record.spriteId && sprite.id!==record.spriteId)throw new Error('This Sprite name now belongs to a different Sprite. This launch will not modify or delete it.');
  }
  private async ownedAPI(record:LaunchRecord) {
    const api=this.apiFactory(await this.store.profile(record.org));
    if(record.spriteId)this.assertIdentity(record,await api.get(record.spriteName));
    return api;
  }
  async provision(record:LaunchRecord):Promise<LaunchRecord> {
    record=await this.store.record(record.id);
    if(record.phase==='cancelled')return record;
    if((record.provisionAttempts??0)>=3)return this.store.patch(record.id,{phase:'failed',error:'Provisioning could not be reconciled after three attempts. Your launch record is retained; reconnect and retry.'});
    const api=this.apiFactory(await this.store.profile(record.org));
    record=await this.store.patch(record.id,{phase:'creating',provisionAttempts:(record.provisionAttempts??0)+1,error:undefined});
    let sprite;
    try{sprite=await api.get(record.spriteName);}
    catch(e){
      if(!(e instanceof APIError) || e.status!==404)throw e;
      try{sprite=await api.create(record.spriteName);}
      catch(createError){
        // A timeout or a name conflict can mean the original request succeeded.
        try{sprite=await api.get(record.spriteName);}catch{throw createError;}
      }
    }
    SpritesAPI.checkedSprite(sprite,record.spriteName);
    this.assertIdentity(record,sprite);
    const current=await this.store.record(record.id);
    record=await this.store.patch(record.id,{provisioned:true,spriteId:sprite.id,url:sprite.url,phase:current.phase});
    if(record.phase==='cancelled')return record;
    return this.setup(record);
  }
  private async setup(record:LaunchRecord):Promise<LaunchRecord> {
    const current=await this.store.record(record.id);
    if(current.phase==='cancelled')return current;
    record=current;
    if((record.setupAttempts??0)>=3 || Date.now()-Date.parse(record.setupStartedAt??record.createdAt)>25*60000)return this.store.patch(record.id,{phase:'failed',error:'Setup could not be resumed within its retry limit. Inspect the terminal and explicitly retry.'});
    record=await this.store.patch(record.id,{setupStartedAt:record.setupStartedAt??new Date().toISOString(),setupAttempts:(record.setupAttempts??0)+1});
    const profile=await this.store.profile(record.org);
    const api=await this.ownedAPI(record);
    const dir=launchDirectory(record.id);
    if(!this.bootstrap)throw new Error('The bundled setup runner is missing.');
    await api.write(record.spriteName,`${dir}/bootstrap.py`,this.bootstrap);
    await api.write(record.spriteName,`${dir}/manifest.json`,JSON.stringify({version:1,launchId:record.id,attemptId:record.attemptId,setupStartedAt:record.setupStartedAt,target:record.target,hostname:previewHostname(record.url!),overrides:record.overrides}));
    await this.rules.terminal(record,profile);
    if((await this.store.record(record.id)).phase==='cancelled')return this.store.record(record.id);
    const sessionId=await this.start(execURL(record.spriteName,['python3',`${dir}/bootstrap.py`,'--manifest',`${dir}/manifest.json`],{disconnect:'25m'}),record.id);
    const after=await this.store.record(record.id);
    return this.store.patch(record.id,{setupSessionId:sessionId,phase:after.phase==='cancelled'?'cancelled':'cloning',message:after.phase==='cancelled'?'Setup cancelled.':'Setup is running on your Sprite.',error:undefined});
  }
  async refresh(id:string):Promise<LaunchRecord> {
    return this.mutate(id,async()=>{
      let record=await this.store.record(id);
      if(!record.provisioned && !FINAL_PHASES.has(record.phase))return this.provision(record);
      const api=await this.ownedAPI(record);
      const state=await api.state(record);
      if(state && (!record.attemptId || state.attemptId===record.attemptId)){
        if(!REMOTE_PHASES.has(state.phase))throw new Error('Sprite returned an invalid setup state.');
        if(!FINAL_PHASES.has(state.phase) && Date.now()-Date.parse(record.setupStartedAt??record.createdAt)>25*60000) {
          return this.store.patch(id,{phase:'failed',error:'Setup is no longer reporting progress after its deadline. The Sprite and checkout are retained; inspect the terminal and retry.'});
        }
        const patch:Partial<LaunchRecord>={phase:state.phase,message:typeof state.message==='string'?state.message.slice(0,2000):undefined,error:typeof state.error==='string'?state.error.slice(0,2000):undefined,recipe:state.recipe,port:state.port};
        record=await this.store.patch(id,patch);
        if(record.phase==='ready'){
          if(record.overrides)await this.store.saveOverrides(`${record.target.owner}/${record.target.repo}`,record.overrides);
          if(!record.previewOpened){
            await this.preview(id,false);
            record=await this.store.patch(id,{previewOpened:true});
          }
        }
        return record;
      }
      if(!FINAL_PHASES.has(record.phase)){
        const sessions=await api.sessions(record.spriteName);
        const session=sessions.find(s=>String(s.id)===record.setupSessionId || s.command?.includes(launchDirectory(record.id)));
        if(session)return record;
        // A setup command may be live without its acknowledgement. The runner's remote lock makes
        // this retry safe; it retains any completed phases and never resets a user checkout.
        if(Date.now()-Date.parse(record.setupStartedAt??record.createdAt)>25*60000)return this.store.patch(id,{phase:'failed',error:'Setup did not report a result before its deadline. Reconnect with the terminal or retry.'});
        return this.setup(record);
      }
      return record;
    });
  }
  async logs(id:string) {
    const record=await this.store.record(id);
    if(!record.provisioned)return '';
    try{return await (await this.ownedAPI(record)).read(record.spriteName,`${launchDirectory(id)}/launch.log`,true);}
    catch(e){if(e instanceof APIError && [404,416].includes(e.status))return '';throw e;}
  }
  async retry(id:string,overrides?:LaunchOverrides) {
    return this.mutate(id,async()=>{
      let record=await this.store.record(id);
      if(!FINAL_PHASES.has(record.phase) && record.phase!=='creating')throw new Error('Cancel the current setup before retrying.');
      if(overrides)validateOverrides(overrides);
      const api=await this.ownedAPI(record);
      if(record.provisioned){
        if(record.setupSessionId){
          const sessions=await api.sessions(record.spriteName);
          if(sessions.some(s=>String(s.id)===record.setupSessionId))await api.kill(record.spriteName,record.setupSessionId);
        }
        await api.deleteFile(record.spriteName,`${launchDirectory(id)}/cancel`);
      }
      record=await this.store.patch(id,{overrides:overrides??record.overrides,attemptId:crypto.randomUUID(),setupStartedAt:new Date().toISOString(),setupAttempts:0,provisionAttempts:0,phase:'queued',error:undefined,message:'Retrying setup on the same Sprite.',previewOpened:false});
      await chrome.alarms.create('launch-recovery',{periodInMinutes:0.5});
      return record.provisioned?this.setup(record):this.provision(record);
    });
  }
  async cancel(id:string) {
    const record=await this.store.record(id);
    if(record.phase==='ready')throw new Error('This app is already running. Use the terminal to manage it or delete its Sprite.');
    if(record.provisioned){
      const api=await this.ownedAPI(record);
      await api.write(record.spriteName,`${launchDirectory(id)}/cancel`,'cancelled by user');
      // The remote cancellation monitor releases the Task and terminates its subprocess group.
    }
    return this.store.patch(id,{phase:'cancelled',message:'Setup cancelled. Your checkout and Sprite are retained.'});
  }
  async delete(id:string) {
    return this.mutate(id,async()=>{
    const record=await this.store.record(id);
    // Reconcile even unacknowledged creations before dropping the only local ownership record.
    const api=this.apiFactory(await this.store.profile(record.org));
    try{this.assertIdentity(record,await api.get(record.spriteName));await api.remove(record.spriteName);}catch(e){if(!(e instanceof APIError)||e.status!==404)throw e;}
    const bindings=(await chrome.storage.local.get('previewBindings')).previewBindings??{};
    for(const [tabId,binding] of Object.entries(bindings))if((binding as any).launchId===id)await this.rules.removeTab(Number(tabId));
    await this.store.remove(id);
    await this.rebuildRules();
    });
  }
  async preview(id:string,active=true) {
    let record=await this.store.record(id);
    if(!record.url || record.phase!=='ready')throw new Error('The app is not ready for preview yet.');
    const profile=await this.store.profile(record.org);
    const sprite=await this.apiFactory(profile).get(record.spriteName);
    this.assertIdentity(record,sprite);
    // The API treats legacy null settings as private. Missing or unknown
    // settings cannot establish privacy; never reopen an explicitly public URL.
    if(sprite.url_settings!==null && sprite.url_settings?.auth!=='sprite')throw new Error('Preview privacy could not be verified. Set this Sprite\'s URL authentication to private before opening it.');
    if(record.url!==sprite.url)record=await this.store.patch(id,{url:sprite.url});
    // Create a blank tab, install the tab-scoped rule, THEN navigate. Never race the first request.
    const tab=await chrome.tabs.create({url:'about:blank',active});
    if(!tab.id)throw new Error('Could not open the preview tab.');
    if(PREVIEW_AUTH_VERIFIED)await this.rules.preview(record,profile,tab.id);
    // Until deployment is verified, the existing browser-cookie login flow is the safe fallback.
    await chrome.tabs.update(tab.id,{url:record.url});
    return {tabId:tab.id,authentication:PREVIEW_AUTH_VERIFIED?'extension':'browser'};
  }
  async terminal(id:string,cols:number,rows:number,fresh=false) {
    const record=await this.store.record(id);
    if(!record.provisioned)throw new Error('Wait for the Sprite to be created.');
    const profile=await this.store.profile(record.org);
    const api=await this.ownedAPI(record);
    await this.rules.terminal(record,profile);
    let sessionId=fresh?undefined:record.terminalSessionId;
    if(sessionId){
      const sessions=await api.sessions(record.spriteName);
      if(!sessions.some(s=>String(s.id)===sessionId))sessionId=undefined;
    }
    const clamp=(value:number,min:number,max:number,fallback:number)=>Number.isInteger(value)?Math.min(max,Math.max(min,value)):fallback;
    return {url:execURL(record.spriteName,sessionId?[]:['bash','-lc','cd /home/sprite/project 2>/dev/null || cd /home/sprite; if [ -r "$1" ]; then exec bash --rcfile "$1" -i; fi; exec bash -l','sprite-launch',`${launchDirectory(id)}/terminal-rc.sh`],{tty:true,cols:clamp(cols,10,500,80),rows:clamp(rows,2,200,24),sessionId,dir:'/home/sprite',disconnect:'0'})};
  }
  async appConnection(id:string) {
    const record=await this.store.record(id);
    if(record.recipe!=='openclaw'||record.phase!=='ready')throw new Error('This launch has no app connection token.');
    const api=await this.ownedAPI(record);
    let token:unknown;
    try {
      const config=JSON.parse(await api.read(record.spriteName,`${launchDirectory(id)}/openclaw.json`));
      token=config?.gateway?.auth?.token;
    }catch{throw new Error('OpenClaw connection configuration is unavailable.');}
    if(typeof token!=='string'||!/^[A-Za-z\d_-]{32,128}$/.test(token))throw new Error('OpenClaw connection configuration is unavailable.');
    return {token};
  }
  async hermesConnection(id:string) {
    const record=await this.store.record(id);
    if(record.recipe!=='hermes'||record.phase!=='ready')throw new Error('This launch has no Hermes sign-in details.');
    const api=await this.ownedAPI(record);
    let connection:unknown;
    try { connection=JSON.parse(await api.read(record.spriteName,`${launchDirectory(id)}/hermes-connection.json`)); }
    catch { throw new Error('Hermes sign-in configuration is unavailable.'); }
    const username=(connection as {username?:unknown}|null)?.username,password=(connection as {password?:unknown}|null)?.password;
    if(typeof username!=='string'||!/^[A-Za-z\d_.-]{1,64}$/.test(username)||typeof password!=='string'||!/^[A-Za-z\d_-]{32,128}$/.test(password))throw new Error('Hermes sign-in configuration is unavailable.');
    return {username,password};
  }
  async login() {
    const response=await fetch(`${API_ORIGIN}/api/v1/token_sessions`,{method:'POST',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new APIError(response.status);
    const body=await response.json();
    const auth=new URL(body.auth_url);
    if(!['https://sprites.dev','https://fly.io'].includes(auth.origin)||!auth.pathname.startsWith('/auth/cli/')||typeof body.session_id!=='string'||!/^[\w-]{16,128}$/.test(body.session_id))throw new Error('Sprites returned an unexpected sign-in URL. Use manual token setup.');
    await chrome.storage.session.set({loginSession:{id:body.session_id,expiresAt:Date.now()+600000}});
    await chrome.tabs.create({url:auth.href});
    return {sessionId:body.session_id,expiresIn:600};
  }
  async pollLogin(sessionId:string) {
    const saved=(await chrome.storage.session.get('loginSession')).loginSession;
    if(!saved||saved.id!==sessionId||saved.expiresAt<Date.now())throw new Error('Sign-in expired. Start again.');
    const response=await fetch(`${API_ORIGIN}/api/v1/token_sessions/${encodeURIComponent(sessionId)}`,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new APIError(response.status);
    const body=await response.json();
    if(body.status==='pending')return {status:'pending'};
    if(body.status!=='completed'||typeof body.token!=='string')throw new Error('Unexpected sign-in response.');
    const profile=await this.addToken(body.token);
    await chrome.storage.session.remove('loginSession');
    return {status:'completed',org:profile.org};
  }
  async addToken(value:string) {
    const token=typeof value==='string'?value.trim():'';
    if(token.length<20||token.length>4096||!/^[a-z\d-]+\/[\w-]+\/(?:[\w-]+\/)?[\w.-]+$/i.test(token))throw new Error('Enter an organization Sprite API token.');
    const profile={org:token.split('/')[0],token};
    await this.apiFactory(profile).fetch('/v1/sprites?max_results=1');
    await this.store.saveProfile(profile);
    await this.rebuildRules();
    return {org:profile.org};
  }
  async rebuildRules() {
    const bindings=(await chrome.storage.local.get('previewBindings')).previewBindings??{};
    await this.rules.clear();
    if(!PREVIEW_AUTH_VERIFIED)return;
    for(const [id,binding] of Object.entries(bindings)){
      try{
        const tab=await chrome.tabs.get(Number(id));
        const info=binding as {launchId:string;hostname:string};
        if(!tab.url||new URL(tab.url).hostname!==info.hostname)continue;
        const record=await this.store.record(info.launchId);
        if(!record.url||previewHostname(record.url)!==info.hostname)continue;
        const profile=await this.store.profile(record.org);
        const sprite=await this.apiFactory(profile).get(record.spriteName);
        this.assertIdentity(record,sprite);
        if(previewHostname(sprite.url)!==info.hostname || sprite.url_settings!==null && sprite.url_settings?.auth!=='sprite')continue;
        await this.rules.preview(record,profile,Number(id));
      }catch{/* Closed tabs and signed-out organizations are intentionally not restored. */}
    }
  }
  async recover() {
    const snapshot=await this.store.snapshot();
    const pending=snapshot.launches.filter(r=>!FINAL_PHASES.has(r.phase));
    for(const record of pending){
      try{await this.refresh(record.id);}catch(e){await this.store.patch(record.id,{message:await this.store.safeError(e)});}
    }
    if(!pending.length)await chrome.alarms.clear('launch-recovery');
  }
  async handle(message:Request):Promise<unknown> {
    switch(message.type){
      case 'snapshot':return this.store.snapshot();
      case 'launch':return this.launch(message.url,message.forceNew,message.refHint);
      case 'login':return this.login();
      case 'poll_login':return this.pollLogin(message.sessionId);
      case 'token':return this.addToken(message.token);
      case 'select_org':await this.store.select(message.org);return this.store.snapshot();
      case 'logout':await this.store.logout(message.org);await this.rebuildRules();return this.store.snapshot();
      case 'refresh':return this.refresh(message.id);
      case 'logs':return this.logs(message.id);
      case 'retry':return this.retry(message.id,message.overrides);
      case 'cancel':return this.cancel(message.id);
      case 'delete':return this.delete(message.id);
      case 'preview':return this.preview(message.id);
      case 'app_connection':return this.appConnection(message.id);
      case 'hermes_connection':return this.hermesConnection(message.id);
      case 'terminal':return this.terminal(message.id,message.cols,message.rows,message.fresh===true);
      case 'terminal_session':{
        if(!/^\d+$/.test(message.sessionId))throw new Error('Invalid terminal session.');
        const record=await this.store.record(message.id);
        const sessions=await this.apiFactory(await this.store.profile(record.org)).sessions(record.spriteName);
        if(!sessions.some(s=>String(s.id)===message.sessionId&&s.tty))throw new Error('Terminal session does not belong to this Sprite.');
        return this.store.patch(message.id,{terminalSessionId:message.sessionId});
      }
    }
  }
}

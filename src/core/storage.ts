import type { LaunchOverrides, LaunchRecord, Profile, Settings, Snapshot } from './types';

export const PREVIEW_AUTH_VERIFIED = import.meta.env.VITE_PREVIEW_AUTH_VERIFIED === 'true';
interface Stored {
  profiles: Record<string, Profile>;
  currentOrg?: string;
  launches: Record<string, LaunchRecord>;
  overrides: Record<string, LaunchOverrides>;
}
const empty = ():Stored => ({profiles:{},launches:{},overrides:{}});
export class Store {
  private queue:Promise<unknown> = Promise.resolve();
  async initialize() {
    await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
    await chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  }
  async read():Promise<Stored> {
    const data=await chrome.storage.local.get('spritesLaunch');
    return {...empty(),...data.spritesLaunch};
  }
  private change<T>(fn:(data:Stored)=>T):Promise<T> {
    const operation=this.queue.then(async()=>{const data=await this.read();const result=fn(data);await chrome.storage.local.set({spritesLaunch:data});return result;});
    this.queue=operation.catch(()=>undefined);
    return operation;
  }
  async snapshot():Promise<Snapshot> {
    const data=await this.read();
    const settings:Settings={currentOrg:data.currentOrg,previewAuthVerified:PREVIEW_AUTH_VERIFIED};
    return {settings,organizations:Object.keys(data.profiles),launches:Object.values(data.launches).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))};
  }
  async profile(org?:string):Promise<Profile> {
    const data=await this.read();
    const profile=data.profiles[org ?? data.currentOrg ?? ''];
    if (!profile) throw new Error('Connect a Sprite organization first.');
    return profile;
  }
  async saveProfile(profile:Profile) {
    await this.change(data=>{data.profiles[profile.org]=profile;data.currentOrg=profile.org;});
  }
  async select(org:string) {
    await this.profile(org);
    await this.change(data=>{data.currentOrg=org;});
  }
  async logout(org:string) {
    await this.change(data=>{delete data.profiles[org];if(data.currentOrg===org)data.currentOrg=Object.keys(data.profiles)[0];});
  }
  async record(id:string):Promise<LaunchRecord> {
    const value=(await this.read()).launches[id];
    if (!value) throw new Error('Launch not found.');
    return value;
  }
  async save(record:LaunchRecord) { await this.change(data=>{data.launches[record.id]=record;});return record; }
  async patch(id:string,patch:Partial<LaunchRecord>) {
    return this.change(data=>{const old=data.launches[id];if(!old)throw new Error('Launch not found.');return data.launches[id]={...old,...patch,updatedAt:new Date().toISOString()};});
  }
  async remove(id:string) {await this.change(data=>{delete data.launches[id];});}
  async overrides(key:string) {return (await this.read()).overrides[key];}
  async saveOverrides(key:string,value:LaunchOverrides) {await this.change(data=>{data.overrides[key]=value;});}
  async safeError(error:unknown) {
    let message=error instanceof Error ? error.message : 'The operation failed.';
    const {profiles}=await this.read();
    for(const {token} of Object.values(profiles)) if(token)message=message.split(token).join('[credential removed]');
    return message.slice(0,1200);
  }
}

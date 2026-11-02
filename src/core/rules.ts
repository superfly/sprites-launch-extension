import type { LaunchRecord, Profile } from './types';
import { execRule, previewRule, previewHostname } from './security';
import { Store } from './storage';
export class Rules {
  private queue:Promise<unknown>=Promise.resolve();
  private serialized<T>(fn:()=>Promise<T>):Promise<T> {
    const result=this.queue.then(fn);this.queue=result.catch(()=>undefined);return result;
  }
  private async put(rule:chrome.declarativeNetRequest.Rule) {await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[rule.id],addRules:[rule]});}
  private async nextId() {const rules=await chrome.declarativeNetRequest.getSessionRules();return Math.max(100,...rules.map(r=>r.id))+1;}
  private async currentProfile(record:LaunchRecord,profile:Profile) {
    // A slow API operation may finish after logout or token replacement. Check
    // inside the same queue as clear(), immediately before installing a rule.
    const current=await new Store().profile(record.org);
    if(profile.org!==record.org || current.org!==profile.org || current.token!==profile.token)throw new Error('Organization credentials changed. Reconnect and try again.');
  }
  async terminal(record:LaunchRecord,profile:Profile) {
    return this.serialized(async()=>{
      const key=`exec:${record.id}`;
      const saved=(await chrome.storage.session.get(key))[key] as number|undefined;
      const id=saved??await this.nextId();
      await this.currentProfile(record,profile);
      await this.put(execRule(id,record.spriteName,profile.token,chrome.runtime.id));
      await chrome.storage.session.set({[key]:id});
    });
  }
  async preview(record:LaunchRecord,profile:Profile,tabId:number) {
    return this.serialized(async()=>{
      if(!record.url)throw new Error('Preview URL unavailable.');
      const key=`preview:${tabId}`;
      const saved=(await chrome.storage.session.get(key))[key] as {ruleId:number}|undefined;
      const id=saved?.ruleId??await this.nextId();
      await this.currentProfile(record,profile);
      await this.put(previewRule(id,record.url,tabId,profile.token));
      await chrome.storage.session.set({[key]:{ruleId:id,launchId:record.id,org:record.org,hostname:previewHostname(record.url)}});
      // Persist the exact owned tab for restoration after extension/service-worker restart.
      const bindings=(await chrome.storage.local.get('previewBindings')).previewBindings??{};
      bindings[tabId]={launchId:record.id,hostname:previewHostname(record.url)};
      await chrome.storage.local.set({previewBindings:bindings});
    });
  }
  async removeTab(tabId:number) {
    return this.serialized(async()=>{
      const key=`preview:${tabId}`;
      const saved=(await chrome.storage.session.get(key))[key] as {ruleId:number}|undefined;
      if(saved)await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[saved.ruleId]});
      await chrome.storage.session.remove(key);
      const bindings=(await chrome.storage.local.get('previewBindings')).previewBindings??{};
      delete bindings[tabId];await chrome.storage.local.set({previewBindings:bindings});
    });
  }
  async clear() {
    return this.serialized(async()=>{
      const rules=await chrome.declarativeNetRequest.getSessionRules();
      await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:rules.map(r=>r.id)});
      const session=await chrome.storage.session.get(null);
      await chrome.storage.session.remove(Object.keys(session).filter(k=>k.startsWith('exec:')||k.startsWith('preview:')));
      await chrome.storage.local.remove('previewBindings');
    });
  }
}

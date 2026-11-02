import { parseGitHubURL } from './github';
import { API_ORIGIN, type LaunchOverrides, type Request } from './types';
const escaped = (s:string) => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function previewHostname(value:string):string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/^[a-z\d-]+\.sprites\.app$/.test(url.hostname) || url.port || url.username || url.password || url.search || url.hash || !['','/'].includes(url.pathname)) throw new Error('Sprite returned an unsupported preview URL.');
  return url.hostname;
}
export function execRule(id:number,sprite:string,token:string,extensionId:string):chrome.declarativeNetRequest.Rule {
  if (!/^[a-z\d-]{1,63}$/.test(sprite)) throw new Error('Invalid Sprite name.');
  return {id,priority:1,action:{type:'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,requestHeaders:[{header:'Authorization',operation:'set' as chrome.declarativeNetRequest.HeaderOperation,value:`Bearer ${token}`}]},condition:{regexFilter:`^wss://${escaped(new URL(API_ORIGIN).hostname)}/v1/sprites/${escaped(sprite)}/exec(/[0-9]+)?(\\?.*)?$`,initiatorDomains:[extensionId],resourceTypes:['websocket' as chrome.declarativeNetRequest.ResourceType]}};
}
export function previewRule(id:number,url:string,tabId:number,token:string):chrome.declarativeNetRequest.Rule {
  const hostname=previewHostname(url);
  return {id,priority:1,action:{type:'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,requestHeaders:[{header:'X-Sprite-Authorization',operation:'set' as chrome.declarativeNetRequest.HeaderOperation,value:`Bearer ${token}`}]},condition:{regexFilter:`^(https|wss)://${escaped(hostname)}(/|$)`,tabIds:[tabId],resourceTypes:['main_frame','sub_frame','stylesheet','script','image','font','object','xmlhttprequest','ping','csp_report','media','websocket','other'] as chrome.declarativeNetRequest.ResourceType[]}};
}
export function validateOverrides(value:unknown):LaunchOverrides {
  if (!value || typeof value !== 'object') throw new Error('Invalid launch settings.');
  const x=value as LaunchOverrides;
  if (typeof x.directory !== 'string' || x.directory.length>512 || x.directory.startsWith('/') || x.directory.split(/[\\/]/).includes('..') || x.directory.includes('\0') || x.directory.includes('\\')) throw new Error('App directory must stay inside the repository.');
  if (typeof x.installCommand !== 'string' || x.installCommand.length>8192 || typeof x.startCommand !== 'string' || !x.startCommand.trim() || x.startCommand.length>8192 || !Number.isInteger(x.port) || x.port<1 || x.port>65535) throw new Error('Enter a start command and port between 1 and 65535.');
  return x;
}
export function authorizeMessage(raw:unknown,sender:chrome.runtime.MessageSender,self:string):Request {
  if (!raw || typeof raw!=='object' || sender.id!==self) throw new Error('Untrusted extension request.');
  const message=raw as Request;
  const trusted=sender.url?.startsWith(`chrome-extension://${self}/`) === true;
  if (!trusted) {
    if (message.type!=='launch' || message.forceNew || message.panelWindowId!==undefined || !sender.tab?.id || sender.frameId && sender.frameId!==0 || !sender.url) throw new Error('This action is only available in the extension.');
    const source=parseGitHubURL(sender.url), target=parseGitHubURL(message.url);
    if (source.url.href!==target.url.href) throw new Error('Launch must match the current GitHub page.');
  }
  const supported=['snapshot','launch','login','poll_login','token','select_org','logout','refresh','logs','retry','cancel','delete','preview','app_connection','hermes_connection','terminal','terminal_session'];
  if (!supported.includes(message.type)) throw new Error('Unknown extension request.');
  if ('id' in message && (typeof message.id!=='string' || !/^[a-f\d-]{36}$/i.test(message.id))) throw new Error('Invalid launch ID.');
  if (message.type==='launch') parseGitHubURL(message.url);
  if (message.type==='launch' && message.panelWindowId!==undefined && (!Number.isInteger(message.panelWindowId)||message.panelWindowId<0))throw new Error('Invalid progress panel window.');
  if (message.type==='retry' && message.overrides) validateOverrides(message.overrides);
  return message;
}

import bootstrap from '../runner/bootstrap.py?raw';
import { Controller } from './core/controller';
import { authorizeMessage } from './core/security';
import type { Response } from './core/types';
import { DocumentExec } from './core/document-exec';
import { Panels } from './core/panels';
import { parseGitHubURL } from './core/github';

const documentExec=new DocumentExec();
const controller=new Controller(undefined,undefined,undefined,undefined,bootstrap,(url,id)=>documentExec.start(url,id));
const panels=new Panels();
const initialized=controller.store.initialize();
chrome.runtime.onConnect.addListener(port=>documentExec.connect(port));
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  let request;
  try { request=authorizeMessage(message,sender,chrome.runtime.id); }
  catch { respond({ok:false,error:'This action is not available from this page.'} satisfies Response);return false; }
  const fromPage=!sender.url?.startsWith(chrome.runtime.getURL(''));
  const windowId=request.type==='launch'?(fromPage?sender.tab?.windowId:request.panelWindowId):undefined;
  const intent=request.type==='launch' && windowId!==undefined?panels.intent(windowId,request.url):undefined;
  // Invoke before the first await so Chrome retains the button's user gesture.
  const opened=intent?(fromPage?panels.open(windowId!):Promise.resolve(true)):undefined;
  void (async()=>{
    try{
      await initialized;
      let data;
      if(request.type==='launch' && intent && await opened){
        await intent.activate();
        data=await controller.launch(request.url,request.forceNew,request.refHint,intent.present);
      }else data=await controller.handle(request);
      // The GitHub page needs only acknowledgement, never launch records,
      // logs, saved command overrides, or organization details.
      if(fromPage && request.type==='launch'){
        const record=data as {id:string;phase:string};
        data={id:record.id,phase:record.phase};
      }
      respond({ok:true,data} satisfies Response);
    }catch(error){
      let detail='The launch could not be started. Reopen the extension and try again.';
      try {detail=await controller.store.safeError(error);}catch{/* Storage itself may be unavailable. */}
      try {await intent?.fail(detail);}catch{/* Still acknowledge the page if panel storage failed. */}
      respond({ok:false,error:fromPage?'Launch could not be started. Open the extension to see details.':detail} satisfies Response);
    }
  })();
  return true;
});
chrome.action.onClicked.addListener(tab=>{
  const opened=panels.open(tab.windowId);
  let source:string|undefined;
  try {if(tab.url){parseGitHubURL(tab.url);source=tab.url;}}catch{/* The toolbar is also a history entry point. */}
  const intent=panels.intent(tab.windowId,source);
  void (async()=>{
    await initialized;
    if(await opened){
      await intent.activate();
      if(source)try{await controller.launch(source,false,undefined,intent.present);}catch(error){await intent.fail(await controller.store.safeError(error));}
    }else{
      const url=new URL(chrome.runtime.getURL('index.html'));
      if(source)url.searchParams.set('url',source);
      await chrome.tabs.create({url:url.href});
    }
  })().catch(()=>undefined);
});
chrome.windows.onRemoved.addListener(id=>void panels.removeWindow(id));
chrome.tabs.onRemoved.addListener(id=>void controller.rules.removeTab(id));
chrome.tabs.onUpdated.addListener((id,change)=>{
  if(change.url && change.url!=='about:blank')void (async()=>{
    const key=`preview:${id}`;
    const binding=(await chrome.storage.session.get(key))[key];
    if(binding && new URL(change.url!).hostname!==binding.hostname)await controller.rules.removeTab(id);
  })();
});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='launch-recovery')void initialized.then(()=>controller.recover());});
chrome.runtime.onStartup.addListener(()=>void initialized.then(async()=>{await controller.rebuildRules();await controller.recover();}));
chrome.runtime.onInstalled.addListener(()=>void initialized.then(()=>controller.rebuildRules()));

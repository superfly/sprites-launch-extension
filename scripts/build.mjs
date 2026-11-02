import { build, loadEnv } from 'vite';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { parsePreviewAuthPolicy } from '../src/core/preview-policy.mjs';
const {version}=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const env=loadEnv('production',process.cwd(),'VITE_');
const policy=parsePreviewAuthPolicy(env.VITE_PREVIEW_AUTH_VERIFIED,env.VITE_PREVIEW_AUTH_ORG_IDS);
// Freeze the same validated policy into every bundle. A local .env file must
// not enable runtime injection while release-status.json claims it is off.
const define={'import.meta.env.VITE_PREVIEW_AUTH_VERIFIED':JSON.stringify(String(policy.enabled)),'import.meta.env.VITE_PREVIEW_AUTH_ORG_IDS':JSON.stringify(policy.orgIds.join(','))};
await build({configFile:false,define,build:{outDir:'dist',emptyOutDir:true,rollupOptions:{input:'index.html'}}});
await build({configFile:false,define,build:{outDir:'dist',emptyOutDir:false,lib:{entry:'src/background.ts',formats:['es'],fileName:()=> 'background.js'},rollupOptions:{output:{inlineDynamicImports:true}}}});
await build({configFile:false,define,build:{outDir:'dist',emptyOutDir:false,lib:{entry:'src/content.ts',name:'SpritesLaunch',formats:['iife'],fileName:()=> 'content.js'}}});
const icons={16:'icons/fly-16.png',32:'icons/fly-32.png',48:'icons/fly-48.png',128:'icons/fly-128.png'};
const manifest={icons,manifest_version:3,name:'Launch on a Sprite',version,description:'Launch public GitHub repositories and pull requests in persistent Sprite workspaces.',minimum_chrome_version:'120',permissions:['storage','alarms','sidePanel','declarativeNetRequestWithHostAccess'],side_panel:{default_path:'index.html?panel=1'},host_permissions:['https://github.com/*','https://api.github.com/*','https://api.sprites.dev/*','wss://api.sprites.dev/*','https://*.sprites.app/*','wss://*.sprites.app/*'],background:{service_worker:'background.js',type:'module'},action:{default_title:'Launch on a Sprite',default_icon:icons},content_scripts:[{matches:['https://github.com/*'],js:['content.js'],run_at:'document_idle'}],content_security_policy:{extension_pages:"script-src 'self'; object-src 'none'; connect-src 'self' https://api.github.com https://api.sprites.dev wss://api.sprites.dev; base-uri 'none'; frame-src 'none'"}};
await mkdir('dist',{recursive:true});
await writeFile('dist/manifest.json',JSON.stringify(manifest,null,2)+'\n');
await writeFile('dist/release-status.json',JSON.stringify({previewAuthVerified:policy.enabled,previewAuthOrgIds:policy.orgIds,version},null,2)+'\n');

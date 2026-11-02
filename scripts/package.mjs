import { spawnSync } from 'node:child_process';
import { mkdirSync,rmSync,readFileSync } from 'node:fs';
const {version}=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
const filename=`sprites-launch-extension-${version}.zip`;
mkdirSync('artifacts',{recursive:true});
rmSync(`artifacts/${filename}`,{force:true});
const zip=spawnSync('zip',['-q','-r',`../artifacts/${filename}`,'.'],{cwd:'dist',stdio:'inherit'});
if(zip.status!==0)process.exit(zip.status??1);

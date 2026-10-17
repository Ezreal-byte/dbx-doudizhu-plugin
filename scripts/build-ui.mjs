import {spawnSync} from 'node:child_process';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
for(const args of [['node_modules/vue-tsc/bin/vue-tsc.js','--noEmit'],['node_modules/vite/bin/vite.js','build']]){
 const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit'});
 if(result.error)throw result.error;
 if(result.status!==0)process.exit(result.status??1);
}

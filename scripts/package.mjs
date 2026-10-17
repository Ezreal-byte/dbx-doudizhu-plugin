import {spawnSync} from 'node:child_process';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const env={...process.env};
const pathKey=Object.keys(env).find(k=>k.toLowerCase()==='path')??'PATH';
if(env.DBX_GO)env[pathKey]=`${path.dirname(env.DBX_GO)}${path.delimiter}${env[pathKey]??''}`;
const target=env.DBX_PLUGIN_TARGET??'windows-x64';
const supportedTargets=['windows-x64','darwin-arm64','darwin-x64'];
if(!supportedTargets.includes(target))throw new Error(`Unsupported target ${target}; expected one of ${supportedTargets.join(', ')}`);
function run(args){const r=spawnSync(process.execPath,args,{cwd:root,env,stdio:'inherit'});if(r.error)throw r.error;if(r.status!==0)process.exit(r.status??1);}
run(['scripts/licenses.mjs']);
run(['scripts/build-ui.mjs']);
run(['node_modules/@dbx-app/plugin-cli/bin/dbx-plugin.js','package','.','--target',target,'--output-dir','dist']);

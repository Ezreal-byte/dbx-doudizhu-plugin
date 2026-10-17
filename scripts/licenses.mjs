import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'assets/licenses');
mkdirSync(out,{recursive:true});
function command(bin,args,cwd=root,shell=false){const r=spawnSync(bin,args,{cwd,encoding:'utf8',shell});if(r.error)throw r.error;if(r.status!==0)throw new Error(r.stderr||r.stdout||`${bin} exited with ${r.status}`);return r.stdout;}
// npm_execpath points to pnpm's JavaScript entry when invoked by pnpm run.
// Run Go directly (without a shell) so executable paths containing spaces work.
const pnpmEntry=process.env.npm_execpath;
const licenseJSON=pnpmEntry&&/\.(?:c?js|mjs)$/i.test(pnpmEntry)
 ? command(process.execPath,[pnpmEntry,'licenses','list','--prod','--json'])
 : command('pnpm',['licenses','list','--prod','--json'],root,process.platform==='win32');
const packages=Object.values(JSON.parse(licenseJSON)).flat();
const inventory=[];
function retain(name,version,dir){
 const names=readdirSync(dir).filter(n=>/^(licen[sc]e|copying|notice|copyright)(\.|$)/i.test(n));
 if(!names.length&&name==='@pixi/colord'){writeFileSync(path.join(out,'_pixi_colord.txt'),`${name} ${version}\nSource: https://raw.githubusercontent.com/omgovich/colord/master/LICENSE.md\n\n${readFileSync(path.join(out,'upstream/colord-LICENSE.md'),'utf8')}`);inventory.push({name,version,file:'_pixi_colord.txt'});return;}
 if(!names.length)throw new Error(`Missing license: ${name}`);
 const filename=name.replace(/[^a-zA-Z0-9._-]/g,'_')+'.txt';
 writeFileSync(path.join(out,filename),`${name} ${version}\n\n`+names.map(n=>`${n}\n${readFileSync(path.join(dir,n),'utf8')}`).join('\n\n'));
 inventory.push({name,version,file:filename});
}
for(const p of packages)retain(p.name,p.versions.join(', '),p.paths[0]);
const go=process.env.DBX_GO??'go';
const modules=command(go,['list','-deps','-f','{{if .Module}}{{.Module.Path}}|{{.Module.Version}}|{{if .Module.Replace}}{{.Module.Replace.Dir}}{{else}}{{.Module.Dir}}{{end}}{{end}}','.'],path.join(root,'backend'));
for(const line of new Set(modules.trim().split(/\r?\n/))){const [name,version,dir]=line.split('|');if(!version)continue;retain(name,version,dir);}
retain('dolotech-doudizhu','see NOTICE',path.join(root,'backend/internal/game/thirdparty/dolotech'));
const goRoot=command(go,['env','GOROOT']).trim();retain('go-runtime',command(go,['version']).trim(),goRoot);
const voiceLicense='kokoro-Apache-2.0.txt';
if(!existsSync(path.join(out,voiceLicense)))throw new Error('Missing Kokoro voice model license');
inventory.push({name:'Kokoro-82M-v1.1-zh',version:'01e7505bd6a7a2ac4975463114c3a7650a9f7218',file:voiceLicense,usage:'Offline generation of bundled voice recordings; model weights excluded'});
writeFileSync(path.join(out,'index.json'),JSON.stringify(inventory,null,2));
console.log(`Retained ${inventory.length} third-party license notices.`);

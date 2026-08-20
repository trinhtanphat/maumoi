import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

async function files(dir) {
  const out=[];
  for (const entry of await readdir(dir,{withFileTypes:true})) {
    const full=path.join(dir,entry.name);
    if(entry.isDirectory()) out.push(...await files(full));
    else if(/\.(js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const targets=[...(await files('src')),...(await files('tests')),...(await files('scripts'))];
for(const file of targets){
  const r=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});
  if(r.status!==0) process.exit(r.status||1);
}
console.log(`Syntax OK: ${targets.length} files`);

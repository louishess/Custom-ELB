'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function inventory(root, directories) {
  const files = {};
  function visit(relative) { const filename=path.join(root,relative); for(const item of fs.readdirSync(filename,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) { const name=path.join(relative,item.name); if(item.isDirectory()) visit(name); else if(item.isFile() && item.name!=='.DS_Store') files[name]=hash(fs.readFileSync(path.join(root,name))); } }
  for(const directory of directories) visit(directory);
  return files;
}
function identity(root) {
  const files = inventory(root,['electron','shared','src','native','scripts']);
  for(const name of ['package.json','package-lock.json','tsconfig.json','vite.config.ts','index.html']) files[name]=hash(fs.readFileSync(path.join(root,name)));
  const sourceHash=hash(JSON.stringify(Object.entries(files).sort(([a],[b])=>a.localeCompare(b))));
  return {version:JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version,schema:require(path.join(root,'electron/backend/schema.cjs')).SCHEMA_VERSION,commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceHash,sourceFiles:files,runtimeFiles:inventory(root,['electron','shared','dist'])};
}
function assertClean(root) {
  const paths=execFileSync('git',['status','--porcelain','--untracked-files=all'],{cwd:root,encoding:'utf8'}).split('\n').filter(Boolean);
  const relevant=paths.filter(line=>/^(electron|shared|src|native|scripts|tests)\//.test(line.slice(3)) || /^(package(-lock)?\.json|tsconfig\.json|vite\.config\.ts|index\.html)$/.test(line.slice(3)));
  if(relevant.length) throw new Error('Commit the release source before packaging: '+relevant.join(', '));
}
module.exports={identity,assertClean,hash};

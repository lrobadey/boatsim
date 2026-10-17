import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),source=path.join(root,'harbor-kit/assets'),target=path.join(root,'public/assets/ormos');
// Copy only distributable files. Authoring sources and evidence stay in the toolkit.
await fs.mkdir(target,{recursive:true});
for(const item of ['manifest.json','models','textures'])await fs.cp(path.join(source,item),path.join(target,item),{recursive:true});
console.log('Staged production Ormos kit at '+target);

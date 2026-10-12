// One audited layout fix for the pinned snapshot: reclaim the empty offline ad column.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../photopea.com');
const dir = path.join(root,'code/pp');
const names=fs.readdirSync(dir).filter(n=>/^pp\d+\.js$/.test(n));
if(names.length!==1) throw new Error('Expected exactly one editor bundle');
const file=path.join(dir,names[0]);
const source=fs.readFileSync(file,'utf8');
const anchor=/\|\|[\w$]+\.[\w$]+\(\)==[\w$]+\.a6\("YMVVHAj=FA"\);/g;
const matches=source.match(anchor)||[];
if(matches.length!==1 && !source.includes('/* desktop:full-width */')) throw new Error('Snapshot changed: review the layout anchor before building');
if(matches.length===1) fs.writeFileSync(file,source.replace(anchor,'||true;/* desktop:full-width */'));
const files={};
function walk(dir) {for(const item of fs.readdirSync(dir,{withFileTypes:true})) {const p=path.join(dir,item.name);if(item.isDirectory()) walk(p);else if(!item.name.endsWith('.orig')) files[path.relative(root,p)]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');}}
walk(root);
fs.writeFileSync(path.resolve(__dirname,'../desktop/snapshot.json'),JSON.stringify({source:'https://www.photopea.com/',editor:names[0],files},null,2)+'\n');
console.log('Prepared snapshot:',names[0],Object.keys(files).length,'assets');

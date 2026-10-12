const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const manifest=require('../desktop/snapshot.json');
for(const [name,expected] of Object.entries(manifest.files)) {
 const bytes=fs.readFileSync(path.resolve(__dirname,'../photopea.com',name));
 if(crypto.createHash('sha256').update(bytes).digest('hex')!==expected) throw new Error('Snapshot mismatch: '+name);
}
console.log('Verified',Object.keys(manifest.files).length,'snapshot assets');

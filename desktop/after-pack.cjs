const {execFileSync}=require('node:child_process');
const path=require('node:path');
module.exports=async context=>{
 if(context.electronPlatformName==='darwin') execFileSync('/usr/bin/xattr',['-cr',path.join(context.appOutDir,context.packager.appInfo.productFilename+'.app')]);
};

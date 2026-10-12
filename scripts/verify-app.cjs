// Launch a separate packaged app/profile. Never touches the user's active session or clipboard.
const {spawn}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const puppeteer=require('puppeteer-core');
const sharp=require('sharp');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const exe=process.argv[2];if(!exe) throw new Error('Pass packaged app executable');
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'photopea-release-test-'));
 const env={...process.env,PHOTOPEA_TEST_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(exe,['--remote-debugging-port=0'],{env,stdio:['ignore','pipe','pipe']});
 let browser,log='';child.stdout.on('data',b=>{log+=b});child.stderr.on('data',b=>{log+=b});
 try {
  for(let i=0;i<150&&!log.match(/ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+/);i++) await wait(200);
  const endpoint=log.match(/ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+/)?.[0];assert(endpoint,log);
  browser=await puppeteer.connect({browserWSEndpoint:endpoint,defaultViewport:null});
  let page;
  for(let i=0;i<100;i++){page=(await browser.pages()).find(p=>p.url().startsWith('https://www.photopea.com'));if(page)break;await wait(100)}
  await page.waitForSelector('.topbar',{timeout:30000});
  const cdp=await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector('.topbar',{timeout:30000});
  console.log('PASS packaged app cold reload with network offline');
  for(const [width,height] of [[1000,700],[1600,1000],[1440,900]]) {
   await page.setViewport({width,height});await wait(300);
   const size=await page.evaluate(()=>({width:innerWidth,editor:document.querySelector('.app').firstElementChild.getBoundingClientRect().width}));
   assert.equal(size.width,size.editor);console.log('PASS full-width resizing',width,height);
  }
  const input=await sharp({create:{width:64,height:48,channels:4,background:'#218d86'}}).png().toBuffer();
  const result=await page.evaluate(async b64=>{
   const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));
   return await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{removeEventListener('message',receive);reject(new Error('Export timeout'))},15000);
    let phase=0;
    function receive(event){
     if(event.source!==window)return;
     if(event.data==='done' && phase===0){phase=1;window.postMessage('app.activeDocument.saveToOE("png");','*');}
     else if(event.data instanceof ArrayBuffer){clearTimeout(timeout);removeEventListener('message',receive);resolve(Array.from(new Uint8Array(event.data)));}
    }
    addEventListener('message',receive);window.postMessage(bytes.buffer,'*');
   });
  },input.toString('base64'));
  const output=Buffer.from(result),meta=await sharp(output).metadata();assert.equal(meta.width,64);assert.equal(meta.height,48);
  assert.deepEqual(await sharp(output).ensureAlpha().raw().toBuffer(),await sharp(input).ensureAlpha().raw().toBuffer());
  console.log('PASS local PNG import/export: dimensions and every pixel identical');
  await page.screenshot({path:'/tmp/photopea-release-verified.png'});
  console.log('PASS packaged release verification');
 } finally {if(browser) await browser.disconnect();child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));fs.rmSync(profile,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});

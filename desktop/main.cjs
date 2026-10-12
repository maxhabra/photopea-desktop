const { app, BrowserWindow, Menu, session, dialog, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ORIGIN = 'https://www.photopea.com';
const root = app.isPackaged ? path.join(process.resourcesPath, 'photopea.com') : path.resolve(__dirname, '../photopea.com');
let win;
let ready = false;
const pending = [];
if (process.env.PHOTOPEA_TEST_DATA) app.setPath('userData', process.env.PHOTOPEA_TEST_DATA);
app.setName('Photopea Desktop');
function trusted(url) { try { return new URL(url).origin === ORIGIN; } catch { return false; } }
async function openFile(file) {
  if (!ready) { pending.push(file); return; }
  try {
    const bytes = await fs.promises.readFile(file);
    await win.webContents.executeJavaScript(`(() => {
      const data = Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}), c => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([data], ${JSON.stringify(path.basename(file))}));
      const target = document.querySelector('div.body');
      if (!target) throw new Error('Editor is not ready');
      target.dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer:transfer}));
    })()`);
  } catch (error) { dialog.showErrorBox('Could not open file', error.message); }
}
app.on('open-file', (event, file) => { event.preventDefault(); openFile(file); });
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if(win) { win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    const ses = session.fromPartition('persist:offline-editor');
    // All HTTP(S) requests terminate here: never fall through to the internet.
    const serve = async request => {
      const url = new URL(request.url);
      if (!['www.photopea.com', 'photopea.com', 'cdn.photopea.com'].includes(url.hostname)) return new Response('Offline', {status:403});
      let relative;
      try { relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'; }
      catch { return new Response('Bad path', {status:400}); }
      const file = path.resolve(root, relative);
      if (!file.startsWith(root + path.sep) || !['GET','HEAD'].includes(request.method)) return new Response('Forbidden', {status:403});
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        if (process.env.PHOTOPEA_TEST_DATA) console.log('MISSING', url.hostname + url.pathname);
        return new Response('Unavailable offline', {status:404});
      }
      return net.fetch(pathToFileURL(file).href);
    };
    ses.protocol.handle('https', serve);
    ses.protocol.handle('http', serve);
    ses.webRequest.onBeforeRequest({urls:['ws://*/*','wss://*/*']}, (_d, callback) => callback({cancel:true}));
    const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write', 'local-fonts']);
    ses.setPermissionCheckHandler((wc, permission, origin) => wc === win?.webContents && trusted(origin) && allowed.has(permission));
    ses.setPermissionRequestHandler((wc, permission, callback, details) => callback(wc === win?.webContents && trusted(details.requestingUrl || wc.getURL()) && allowed.has(permission)));
    win = new BrowserWindow({width:1440,height:900,minWidth:720,minHeight:480,title:'Photopea Desktop',webPreferences:{session:ses,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {label:'Photopea Desktop',submenu:[{role:'about'},{type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{role:'quit'}]},
      {label:'File',submenu:[{label:'Open…',accelerator:'CmdOrCtrl+O',click:async()=>{const r=await dialog.showOpenDialog(win,{properties:['openFile','multiSelections']});for(const f of r.filePaths) await openFile(f);}},{role:'close'}]},
      {label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
      {label:'View',submenu:[{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{type:'separator'},{role:'togglefullscreen'}]},
      {label:'Window',submenu:[{role:'minimize'},{role:'zoom'},{role:'front'}]}
    ]));
    win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
    win.webContents.on('will-navigate', (event, url) => {if(!trusted(url)) event.preventDefault();});
    win.webContents.on('will-prevent-unload', event => {
      if(dialog.showMessageBoxSync(win,{type:'question',buttons:['Keep Editing','Discard Changes'],defaultId:0,cancelId:0,message:'Close Photopea?',detail:'Unsaved changes will be lost.'}) === 1) event.preventDefault();
    });
    win.webContents.on('did-finish-load', async () => {
      // Dynamic editor scripts load after the HTML document finishes.
      try {
        await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const t=setInterval(()=>{if(document.querySelector('div.topbar')){clearInterval(t);resolve(true)}else if(++n>300){clearInterval(t);reject(new Error('Editor startup timed out'))}},100)})`);
        ready = true;
        for (const file of pending.splice(0)) await openFile(file);
      } catch(error) { console.error(error); }
    });
    await win.loadURL(ORIGIN + '/#');
  });
  app.on('window-all-closed', () => app.quit());
}

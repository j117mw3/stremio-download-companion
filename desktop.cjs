const {app,BrowserWindow,Tray,Menu,nativeImage,dialog,ipcMain,shell,clipboard}=require('electron');
const path=require('path');let win,tray,quitting=false;
const packageVersion=require('./package.json').version;
if(!app.requestSingleInstanceLock())app.quit();else{
app.on('second-instance',()=>{win?.show();win?.focus()});
app.whenReady().then(async()=>{
process.env.COMPANION_DATA=app.getPath('userData');
const {cfg}=await import('./src/config.js');
const base='http://127.0.0.1:'+cfg.port;
let existing=false;
try { const response=await fetch(base+'/manifest.json',{signal:AbortSignal.timeout(1500)});const manifest=await response.json();if(manifest.id!=='local.season.downloader')throw Error('Another application is using port '+cfg.port);existing=true; } catch(error) {if(error.message.startsWith('Another application'))throw error;}
if(existing){const response=await fetch(base+'/api/health',{signal:AbortSignal.timeout(1500)});if(!response.ok)throw Error('An older companion backend is running. Quit that companion before opening this updated version.');const health=await response.json();if(health.version!==packageVersion)throw Error('A different companion version is running. Quit it before opening this version.');}
ipcMain.handle('choose-folder',async()=>{const result=await dialog.showOpenDialog(win,{properties:['openDirectory','createDirectory']});return result.canceled?null:result.filePaths[0]});
ipcMain.handle('open-folder',()=>shell.openPath(cfg.downloadDir));
ipcMain.handle('install-addon',async()=>{const manifest=base+'/manifest.json';const response=await fetch(manifest);if(!response.ok)throw Error('Companion manifest is unavailable');clipboard.writeText(manifest);await shell.openExternal('stremio:///addons?addon='+encodeURIComponent(manifest));return {manifest,copied:true};});
if(!existing){const backend=await import('./src/server.js');await backend.ready;}
win=new BrowserWindow({width:1180,height:800,show:true,backgroundColor:'#14141c',webPreferences:{preload:path.join(__dirname,"preload.cjs"),nodeIntegration:false,contextIsolation:true,sandbox:true}});
win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
win.webContents.on('will-navigate',(e,url)=>{if(!url.startsWith(base+'/'))e.preventDefault()});
win.setMenuBarVisibility(false);
await win.loadURL(base+'/');win.show();win.focus();win.on('close',e=>{if(!quitting){e.preventDefault();win.hide()}});
const icon=nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==');
tray=new Tray(icon);tray.setToolTip('Stremio Download Companion');tray.setContextMenu(Menu.buildFromTemplate([{label:'Open',click:()=>win.show()},{label:'Quit',click:()=>{quitting=true;if(existing)app.quit();else process.emit('SIGTERM')}}]));tray.on('double-click',()=>win.show());
}).catch(error=>{dialog.showErrorBox('Companion could not start',error.message);app.quit()});app.on('window-all-closed',()=>{});app.on('before-quit',()=>{quitting=true});}

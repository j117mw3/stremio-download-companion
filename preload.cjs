const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('companion',{chooseFolder:()=>ipcRenderer.invoke('choose-folder'),openFolder:()=>ipcRenderer.invoke('open-folder'),installAddon:()=>ipcRenderer.invoke('install-addon')});

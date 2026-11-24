const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ledger', { view: () => ipcRenderer.invoke('wallet-view'), start: v => ipcRenderer.invoke('wallet-start', v) });

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('videoPDF', {
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  restoreWorkspace: () => ipcRenderer.invoke('workspace:restore'),
  openVideo: id => ipcRenderer.invoke('video:open', id),
  capture: (videoId, image, time) => ipcRenderer.invoke('snapshot:capture', videoId, image, time),
  saveSnapshots: (videoId, snapshots) => ipcRenderer.invoke('snapshot:save', videoId, snapshots),
  deleteSnapshot: (videoId, id) => ipcRenderer.invoke('snapshot:delete', videoId, id),
  reset: videoId => ipcRenderer.invoke('snapshot:reset', videoId),
  restoreSnapshots: videoId => ipcRenderer.invoke('snapshot:restore', videoId),
  saveDrawing: (videoId, id, image) => ipcRenderer.invoke('snapshot:draw', videoId, id, image),
  savePDF: (videoId, data) => ipcRenderer.invoke('pdf:save', videoId, data)
});

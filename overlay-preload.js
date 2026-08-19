const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlayApi", {
  done: (rect) => ipcRenderer.send("region-selected", rect),
});

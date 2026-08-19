const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("companionApi", {
  onNote: (cb) => ipcRenderer.on("companion-note", (_e, data) => cb(data)),
  hide: () => ipcRenderer.send("companion-hide"),
  followUp: (mode) => ipcRenderer.send("companion-followup", { mode }),
  topicConfirm: (accept) => ipcRenderer.send("companion-topic-confirm", { accept }),
  resize: (height) => ipcRenderer.send("companion-resize", { height }),
});

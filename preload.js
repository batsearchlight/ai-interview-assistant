const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // Settings
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (s) => ipcRenderer.invoke("save-settings", s),
  setAlwaysOnTop: (flag) => ipcRenderer.invoke("set-always-on-top", flag),

  // Modell-Listen von Replicate
  listModels: () => ipcRenderer.invoke("list-models"),

  // Transkription: fertige Aeusserung (PCM16 @16kHz) an den Main-Prozess
  transcribeUtterance: (channel, itemId, pcm) =>
    ipcRenderer.send("transcribe-utterance", { channel, itemId, pcm }),

  // Antworten (flow = { topic, suggestions } fuer die Ablauf-Einordnung)
  generateAnswer: (question, history, flow) =>
    ipcRenderer.invoke("generate-answer", { question, history, flow }),

  // Screenshot-Analyse
  selectRegion: () => ipcRenderer.invoke("select-region"),
  analyzeScreen: (history) => ipcRenderer.invoke("analyze-screen", { history }),

  // Schnell-Tipp (nur Gespraechsverlauf)
  quickTip: (history) => ipcRenderer.invoke("quick-tip", { history }),

  // Follow-up auf eine Antwort (Mehr / Code / Pro-Kontra / Beispiele)
  followUp: (mode, question, answer, history) =>
    ipcRenderer.invoke("follow-up", { mode, question, answer, history }),

  // Companion Mode
  companionCheck: (history, flow) =>
    ipcRenderer.invoke("companion-check", { history, flow }),
  hideCompanionOverlay: () => ipcRenderer.send("companion-hide"),
  listDisplays: () => ipcRenderer.invoke("list-displays"),

  // Gespeicherte Gespraeche
  convList: () => ipcRenderer.invoke("conv-list"),
  convGet: (id) => ipcRenderer.invoke("conv-get", id),
  convSave: (data) => ipcRenderer.invoke("conv-save", data),
  convDelete: (id) => ipcRenderer.invoke("conv-delete", id),

  // Events aus dem Main-Prozess
  onTranscript: (cb) => ipcRenderer.on("transcript", (_e, data) => cb(data)),
  onSttStatus: (cb) => ipcRenderer.on("stt-status", (_e, data) => cb(data)),
  onAnswerStart: (cb) => ipcRenderer.on("answer-start", (_e, data) => cb(data)),
  onAnswerDelta: (cb) => ipcRenderer.on("answer-delta", (_e, data) => cb(data)),
  onAnswerDone: (cb) => ipcRenderer.on("answer-done", (_e, data) => cb(data)),
  onUsage: (cb) => ipcRenderer.on("usage-update", (_e, data) => cb(data)),
  onCompanionTopicAccepted: (cb) =>
    ipcRenderer.on("companion-topic-accepted", (_e, data) => cb(data)),
});

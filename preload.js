const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // settings
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (s) => ipcRenderer.invoke("save-settings", s),
  setAlwaysOnTop: (flag) => ipcRenderer.invoke("set-always-on-top", flag),

  // model lists from Replicate
  listModels: () => ipcRenderer.invoke("list-models"),

  // transcription: send a finished utterance (PCM16 @16 kHz) to the main process
  transcribeUtterance: (channel, itemId, pcm) =>
    ipcRenderer.send("transcribe-utterance", { channel, itemId, pcm }),

  // answers (flow = { topic, suggestions } for the interview-flow classification)
  generateAnswer: (question, history, flow) =>
    ipcRenderer.invoke("generate-answer", { question, history, flow }),

  // screen analysis
  selectRegion: () => ipcRenderer.invoke("select-region"),
  analyzeScreen: (history) => ipcRenderer.invoke("analyze-screen", { history }),

  // quick tip (conversation history only)
  quickTip: (history) => ipcRenderer.invoke("quick-tip", { history }),

  // follow-up on an answer (more / code / pros-cons / examples)
  followUp: (mode, question, answer, history) =>
    ipcRenderer.invoke("follow-up", { mode, question, answer, history }),

  // companion mode
  companionCheck: (history, flow) =>
    ipcRenderer.invoke("companion-check", { history, flow }),
  hideCompanionOverlay: () => ipcRenderer.send("companion-hide"),
  listDisplays: () => ipcRenderer.invoke("list-displays"),

  // saved conversations
  convList: () => ipcRenderer.invoke("conv-list"),
  convGet: (id) => ipcRenderer.invoke("conv-get", id),
  convSave: (data) => ipcRenderer.invoke("conv-save", data),
  convDelete: (id) => ipcRenderer.invoke("conv-delete", id),

  // events from the main process
  onTranscript: (cb) => ipcRenderer.on("transcript", (_e, data) => cb(data)),
  onSttStatus: (cb) => ipcRenderer.on("stt-status", (_e, data) => cb(data)),
  onAnswerStart: (cb) => ipcRenderer.on("answer-start", (_e, data) => cb(data)),
  onAnswerDelta: (cb) => ipcRenderer.on("answer-delta", (_e, data) => cb(data)),
  onAnswerDone: (cb) => ipcRenderer.on("answer-done", (_e, data) => cb(data)),
  onUsage: (cb) => ipcRenderer.on("usage-update", (_e, data) => cb(data)),
  onCompanionTopicAccepted: (cb) =>
    ipcRenderer.on("companion-topic-accepted", (_e, data) => cb(data)),
});

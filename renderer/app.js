/* global api */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let settings = null;
let recording = false;
let audioContexts = [];
let mediaStreams = [];

// transcript history used as LLM context
const history = []; // { speaker: "Interviewer" | "Me", text }
const MAX_HISTORY = 24;

const $ = (id) => document.getElementById(id);

const transcriptEl = $("transcript");
const answersEl = $("answers");

// ---------------------------------------------------------------------------
// Question detection (runtime feature: covers German AND English interviews)
// ---------------------------------------------------------------------------

const QUESTION_STARTS = [
  // German
  "was ", "wie ", "warum", "wieso", "weshalb", "wann ", "wo ", "wer ",
  "welche", "womit", "wodurch", "wofuer", "wofür", "koennen sie", "können sie",
  "kannst du", "haben sie", "hast du", "erzaehlen sie", "erzählen sie",
  "erzaehl ", "erzähl ", "erklaeren sie", "erklären sie", "erklaer ", "erklär ",
  "beschreiben sie", "beschreib ", "nennen sie", "nenn ",
  // English
  "what ", "how ", "why ", "when ", "where ", "who ", "which ", "can you",
  "could you", "would you", "do you", "did you", "have you", "tell me",
  "describe ", "explain ", "walk me through",
];

function looksLikeQuestion(text) {
  const t = text.trim().toLowerCase();
  if (t.length < 8) return false;
  if (/\?\s*$/.test(t)) return true;
  return QUESTION_STARTS.some((s) => t.startsWith(s));
}

// ---------------------------------------------------------------------------
// Transcript rendering
// ---------------------------------------------------------------------------

// one element per (channel, itemId); placeholder until the result arrives
const utteranceEls = new Map();

function keyOf(channel, itemId) {
  return `${channel}:${itemId}`;
}

function renderTranscript({ channel, itemId, text, final }) {
  const key = keyOf(channel, itemId);
  let el = utteranceEls.get(key);

  if (!el) {
    el = document.createElement("div");
    el.className = `utterance ${channel} partial`;
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = channel === "other" ? "Interviewer" : "Me";
    const body = document.createElement("span");
    body.className = "body";
    el.append(who, body);
    transcriptEl.appendChild(el);
    utteranceEls.set(key, el);
  }

  const body = el.querySelector(".body");

  if (final) {
    // empty transcription (silence/failure): remove the placeholder
    if (!text.trim()) {
      el.remove();
      utteranceEls.delete(key);
      return;
    }

    body.textContent = text;
    el.classList.remove("partial");

    // Rebuild the history from display order — transcriptions can finish
    // in a different order than they were spoken.
    rebuildHistory();

    if (channel === "other") {
      const isQuestion = looksLikeQuestion(text);
      if (isQuestion) el.classList.add("question");
      // EVERY substantial interviewer statement is (batched and) sent for
      // AI classification — [NO_ACTION] filters out non-questions. This
      // also catches questions without a question mark and questions that
      // were chopped into segments ("So, Angular directives." / "Tell me ...").
      queueAutoTrigger(text, isQuestion);
    }
  } else {
    body.textContent = text;
  }

  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// Keep the LLM context in the order utterances appear in the transcript
// (= speech start order), not in completion order
function rebuildHistory() {
  history.length = 0;
  const els = transcriptEl.querySelectorAll(".utterance:not(.partial):not(.note)");
  for (const el of els) {
    const speaker = el.classList.contains("other") ? "Interviewer" : "Me";
    const text = el.querySelector(".body")?.textContent || "";
    if (text) history.push({ speaker, text });
  }
  while (history.length > MAX_HISTORY) history.shift();
}

// Visible note line in the transcript (e.g. for transcription errors)
let lastNote = { text: "", time: 0 };
function addSystemNote(msg) {
  const now = Date.now();
  if (msg === lastNote.text && now - lastNote.time < 10000) return; // spam guard
  lastNote = { text: msg, time: now };
  const el = document.createElement("div");
  el.className = "utterance note";
  el.textContent = `⚠ ${msg}`;
  transcriptEl.appendChild(el);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

const answerEls = new Map();

// --- Topic flow: the AI classifies each interviewer statement via a control
// line ([TOPIC: ...] / [FOLLOW_UP] / [NO_ACTION]) — this is the related state
let currentTopic = null;
let topicSuggestions = []; // previous suggestions for the current topic

function topicDividerEl(name) {
  const d = document.createElement("div");
  d.className = "topic-divider";
  d.textContent = `📌 ${name}`;
  return d;
}

function setTopic(name, beforeCard) {
  currentTopic = name;
  topicSuggestions = [];
  const d = topicDividerEl(name);
  if (beforeCard && beforeCard.parentElement === answersEl) {
    answersEl.insertBefore(d, beforeCard);
  } else {
    answersEl.appendChild(d);
  }
  transcriptEl.appendChild(topicDividerEl(name));
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function addFlowTag(el, text) {
  const tag = document.createElement("div");
  tag.className = "flowtag";
  tag.textContent = text;
  el.insertBefore(tag, el.firstChild);
}

function removeAnswerCard(id, el) {
  el.remove();
  answerEls.delete(id);
}

// evaluate the control line → "removed" | "handled" | "raw"
function applyFlowControl(el, firstLine, id) {
  const mTopic = firstLine.match(/^\[?TOPIC:?\s*(.+?)\]?\s*$/i);
  if (/NO_ACTION/i.test(firstLine)) {
    removeAnswerCard(id, el);
    return "removed";
  }
  if (mTopic && /TOPIC/i.test(firstLine)) {
    const name = mTopic[1].replace(/[\[\]]/g, "").trim();
    // same topic reported again → no new marker, show as follow-up
    if (currentTopic && name.toLowerCase() === currentTopic.toLowerCase()) {
      el.classList.add("deepening");
      addFlowTag(el, `↳ Follow-up — ${currentTopic}`);
      return "handled";
    }
    setTopic(name, el);
    addFlowTag(el, `📌 New topic: ${currentTopic}`);
    return "handled";
  }
  if (/FOLLOW_UP/i.test(firstLine)) {
    el.classList.add("deepening");
    addFlowTag(el, `↳ Follow-up${currentTopic ? ` — ${currentTopic}` : ""}`);
    return "handled";
  }
  return "raw"; // no control line recognized → show everything
}

function askQuestion(question) {
  // keep the context small (faster answer), without the current question
  const ctx = history.slice(0, -1).slice(-8);
  api.generateAnswer(question, ctx, {
    topic: currentTopic,
    suggestions: topicSuggestions.slice(-3),
  });
}

// --- Auto trigger: batch interviewer statements and let the AI classify ---
// Detected questions fire immediately; everything else after a short pause
// in speech so statements chopped into segments reach the AI as one piece.

let pendingOther = [];
let autoTriggerTimer = null;
const AUTO_TRIGGER_DEBOUNCE_MS = 1800;
const AUTO_TRIGGER_MIN_CHARS = 12;

function queueAutoTrigger(text, isQuestion) {
  if (!$("chkCompanion").checked && !$("chkAuto").checked) return;
  pendingOther.push(text);
  clearTimeout(autoTriggerTimer);
  // Companion mode: ALWAYS wait briefly — interviewers often refine their
  // question right after the question mark. The wait window collects the
  // refinement instead of showing a premature answer.
  if (isQuestion && !$("chkCompanion").checked) {
    fireAutoTrigger();
  } else {
    autoTriggerTimer = setTimeout(
      fireAutoTrigger,
      $("chkCompanion").checked ? 2000 : AUTO_TRIGGER_DEBOUNCE_MS
    );
  }
}

function fireAutoTrigger() {
  clearTimeout(autoTriggerTimer);
  autoTriggerTimer = null;
  const statement = pendingOther.join(" ").trim();
  pendingOther = [];
  if (statement.length < AUTO_TRIGGER_MIN_CHARS) return; // "Yes.", "Mhm." etc.
  if ($("chkCompanion").checked) {
    companionTick(true);
  } else if ($("chkAuto").checked) {
    askQuestion(statement);
  }
}

api.onAnswerStart(({ id, question, kind }) => {
  const el = document.createElement("div");
  el.className = "answer streaming";
  el.innerHTML = `<div class="q"></div><div class="a"></div>`;
  el.querySelector(".q").textContent = `❓ ${question}`;
  el.dataset.question = question;
  el.dataset.kind = kind || "generic";
  // answer cards first wait for the AI's control line
  if (el.dataset.kind === "answer") el.dataset.ctl = "wait";
  answersEl.appendChild(el);
  answerEls.set(id, el);
  answersEl.scrollTop = answersEl.scrollHeight;
});

api.onAnswerDelta(({ id, text }) => {
  const el = answerEls.get(id);
  if (!el) return;

  if (el.dataset.ctl === "wait") {
    el._buf = (el._buf || "") + text;
    const nl = el._buf.indexOf("\n");
    if (nl === -1) {
      // NO_ACTION can arrive without a newline
      if (/\[NO_ACTION\]/i.test(el._buf)) removeAnswerCard(id, el);
      return;
    }
    const first = el._buf.slice(0, nl).trim();
    const rest = el._buf.slice(nl + 1).replace(/^\n+/, "");
    el.dataset.ctl = "done";
    const res = applyFlowControl(el, first, id);
    if (res === "removed") return;
    el.querySelector(".a").textContent = res === "raw" ? el._buf : rest;
    el._buf = "";
  } else {
    el.querySelector(".a").textContent += text;
  }
  answersEl.scrollTop = answersEl.scrollHeight;
});

api.onAnswerDone(({ id }) => {
  const el = answerEls.get(id);
  if (!el) return;

  // the stream ended before a control line was resolved
  if (el.dataset.ctl === "wait") {
    const buf = (el._buf || "").trim();
    el.dataset.ctl = "done";
    if (!buf || /NO_ACTION/i.test(buf)) {
      removeAnswerCard(id, el);
      return;
    }
    const res = applyFlowControl(el, buf.split("\n")[0].trim(), id);
    if (res === "removed") return;
    el.querySelector(".a").textContent =
      res === "raw" ? buf : buf.split("\n").slice(1).join("\n").trim();
    el._buf = "";
  }

  el.classList.remove("streaming");
  // preserve the raw text (rich rendering replaces the DOM content next)
  const a = el.querySelector(".a");
  a.dataset.raw = a.textContent;
  renderRichContent(el);
  addAnswerActions(el);

  // attach finished suggestions to the current topic (for the next classification)
  if (el.dataset.kind === "answer") {
    topicSuggestions.push(a.dataset.raw);
    if (topicSuggestions.length > 6) topicSuggestions.shift();
  }
});

// ---------------------------------------------------------------------------
// Follow-up buttons on answer cards
// ---------------------------------------------------------------------------

const FOLLOWUP_BUTTONS = [
  ["elaborate", "➕ More", "A bit more detail on this answer"],
  ["code", "</> Code", "Small code example with highlighting"],
  ["proscons", "⚖ Pros/Cons", "Compact pros and cons list"],
  ["examples", "🧩 Examples", "2-3 concrete examples"],
];

function addAnswerActions(el) {
  if (el.querySelector(".actions")) return;
  const bar = document.createElement("div");
  bar.className = "actions";
  for (const [mode, label, title] of FOLLOWUP_BUTTONS) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener("click", () => {
      const a = el.querySelector(".a");
      const question =
        el.dataset.question || el.querySelector(".q")?.textContent || "";
      const answer = a?.dataset.raw ?? a?.textContent ?? "";
      api.followUp(mode, question, answer, history.slice(-8));
    });
    bar.appendChild(btn);
  }
  el.appendChild(bar);
}

// ---------------------------------------------------------------------------
// Rich content rendering (fenced code blocks in finished answers)
// ---------------------------------------------------------------------------

let mermaidReady = false;
let mmdCounter = 0;

function ensureMermaid() {
  if (mermaidReady || typeof mermaid === "undefined") return mermaidReady;
  mermaid.initialize({
    startOnLoad: false,
    theme: "dark",
    securityLevel: "loose",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
  });
  mermaidReady = true;
  return true;
}

// Render fenced code blocks: ```mermaid as a diagram, everything else as a
// syntax-highlighted code snippet (highlight.js, bundled locally)
async function renderRichContent(answerEl) {
  const a = answerEl.querySelector(".a");
  const raw = a.dataset.raw ?? a.textContent;
  if (!raw.includes("```")) return;

  // split with 2 capture groups → [text, language, code, text, language, code, ...]
  const parts = raw.split(/```([\w+-]*)[ \t]*\n?([\s\S]*?)```/g);
  a.innerHTML = "";

  for (let i = 0; i < parts.length; i++) {
    const mod = i % 3;
    if (mod === 0) {
      const t = (parts[i] || "").trim();
      if (t) {
        const div = document.createElement("div");
        div.className = "answer-text";
        div.textContent = t;
        a.appendChild(div);
      }
    } else if (mod === 1) {
      const lang = (parts[i] || "").toLowerCase();
      const code = (parts[i + 1] || "").trim();
      i++; // also consume the code part

      if (lang === "mermaid" && ensureMermaid()) {
        const box = document.createElement("div");
        box.className = "mermaid-box";
        a.appendChild(box);
        try {
          const { svg } = await mermaid.render(`mmd${++mmdCounter}`, code);
          box.innerHTML = svg;
        } catch {
          const pre = document.createElement("pre");
          pre.textContent = code;
          box.appendChild(pre);
        }
      } else {
        const box = document.createElement("pre");
        box.className = "code-box";
        const codeEl = document.createElement("code");
        if (lang) codeEl.className = `language-${lang}`;
        codeEl.textContent = code;
        box.appendChild(codeEl);
        a.appendChild(box);
        try {
          if (typeof hljs !== "undefined") hljs.highlightElement(codeEl);
        } catch {}
      }
    }
  }
  answersEl.scrollTop = answersEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// Companion mode: check the conversation periodically (and on questions);
// helpful notes appear as an overlay on the selected display
// ---------------------------------------------------------------------------

let companionTimer = null;
let companionBusy = false;
let companionLastOtherCount = 0;

// Only count new INTERVIEWER utterances — the interviewee's own answer must
// not trigger new notes (stability of the conversation thread)
function otherUtteranceCount() {
  return history.filter((h) => h.speaker === "Interviewer").length;
}

// Static answer card (for companion results, which do not stream)
function addStaticAnswerCard(label, text, opts = {}) {
  const el = document.createElement("div");
  el.className = "answer";
  el.innerHTML = `<div class="q"></div><div class="a"></div>`;
  el.querySelector(".q").textContent = label;
  el.dataset.question = label;
  el.dataset.kind = opts.kind || "companion";
  if (opts.deepening) el.classList.add("deepening");
  if (opts.flowtag) addFlowTag(el, opts.flowtag);
  const a = el.querySelector(".a");
  a.textContent = text;
  a.dataset.raw = text;
  answersEl.appendChild(el);
  renderRichContent(el);
  addAnswerActions(el);
  answersEl.scrollTop = answersEl.scrollHeight;
}

async function companionTick(force) {
  if (!recording || !$("chkCompanion").checked || companionBusy) return;
  if (!force && otherUtteranceCount() === companionLastOtherCount) return;
  companionBusy = true;
  companionLastOtherCount = otherUtteranceCount();
  try {
    const res = await api.companionCheck(history.slice(-12), {
      topic: currentTopic,
      suggestions: topicSuggestions.slice(-6),
    });
    const isDuplicate =
      res && res.text && topicSuggestions.some((s) => s.trim() === res.text.trim());

    if (res && res.action === "topic" && !isDuplicate) {
      const sameTopic =
        res.topic &&
        currentTopic &&
        res.topic.toLowerCase() === currentTopic.toLowerCase();
      if (res.topic && !sameTopic) {
        setTopic(res.topic);
        addStaticAnswerCard("🤖 Companion", res.text, {
          flowtag: `📌 New topic: ${res.topic}`,
        });
      } else {
        // same/unnamed topic → show as a regular note without a new marker
        addStaticAnswerCard("🤖 Companion", res.text, {
          deepening: !!sameTopic,
          flowtag: sameTopic ? `↳ Follow-up — ${currentTopic}` : null,
        });
      }
      topicSuggestions.push(res.text);
    } else if (res && res.action === "deep" && !isDuplicate) {
      addStaticAnswerCard("🤖 Companion", res.text, {
        deepening: true,
        flowtag: `↳ Follow-up${currentTopic ? ` — ${currentTopic}` : ""}`,
      });
      topicSuggestions.push(res.text);
    }
    // "done" → overlay hidden; "none" → nothing;
    // "pending" → topic change waits for confirmation in the overlay
  } catch {}
  companionBusy = false;

  // If the interviewer kept talking DURING the check (refined the question),
  // re-check immediately with the updated history — the AI then corrects
  // via a "↳ Clarified" block if needed.
  if (
    recording &&
    $("chkCompanion").checked &&
    otherUtteranceCount() !== companionLastOtherCount
  ) {
    setTimeout(() => companionTick(true), 500);
  }
}

// Topic change confirmed by the user (overlay button "Switch")
api.onCompanionTopicAccepted(({ topic, text }) => {
  setTopic(topic);
  addStaticAnswerCard("🤖 Companion", text, {
    flowtag: `📌 New topic: ${topic}`,
  });
  topicSuggestions.push(text);
});

function updateCompanionTimer() {
  clearInterval(companionTimer);
  companionTimer = null;
  if (recording && $("chkCompanion").checked) {
    const sec = Math.max(5, parseFloat(settings.companionIntervalSec) || 20);
    companionTimer = setInterval(() => companionTick(false), sec * 1000);
  }
}

$("chkCompanion").addEventListener("change", async (e) => {
  settings = await api.saveSettings({ companionMode: e.target.checked });
  updateCompanionTimer();
});

// ---------------------------------------------------------------------------
// Quick tip (conversation history only, no detected question)
// ---------------------------------------------------------------------------

function requestQuickTip() {
  if (!history.length) return;
  api.quickTip(history.slice(-14));
}

$("btnTip").addEventListener("click", requestQuickTip);

// Ctrl+T as a shortcut while the window is focused
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === "t") {
    e.preventDefault();
    requestQuickTip();
  }
});

$("btnRegion").addEventListener("click", async () => {
  const region = await api.selectRegion();
  if (region) settings.captureRegion = region;
});

$("btnShot").addEventListener("click", async () => {
  if (!settings.captureRegion) {
    const region = await api.selectRegion();
    if (!region) return;
    settings.captureRegion = region;
  }
  api.analyzeScreen(history.slice(-14));
});

// manual question
$("btnAsk").addEventListener("click", () => {
  const input = $("manualQuestion");
  let q = input.value.trim();
  if (!q) {
    // use the interviewer's most recent statement as the question
    const lastOther = [...history].reverse().find((h) => h.speaker === "Interviewer");
    if (lastOther) q = lastOther.text;
  }
  if (q) {
    askQuestion(q);
    input.value = "";
  }
});
$("manualQuestion").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btnAsk").click();
});

// ---------------------------------------------------------------------------
// Speech segmentation (simple energy-based VAD)
// ---------------------------------------------------------------------------
// The AudioWorklet delivers Int16 chunks @16 kHz (2048 samples = 128 ms).
// An utterance starts when the energy threshold is exceeded and ends after
// SILENCE_END_MS of silence. Finished utterances are sent as PCM to the
// main process, which transcribes them via Replicate.

const SAMPLE_RATE = 16000;
const VAD_THRESHOLD = 450;   // RMS on Int16
const SILENCE_END_MS = 600;
const MIN_SPEECH_MS = 350;
const PREROLL_CHUNKS = 3;

// During long speech a segment is cut off every N seconds and transcribed
// immediately (configurable in the settings)
function maxSegmentMs() {
  const sec = parseFloat(settings?.maxSegmentSec);
  return (isFinite(sec) && sec >= 0.5 ? sec : 1) * 1000;
}

function rmsInt16(arr) {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
  return Math.sqrt(sum / arr.length);
}

class UtteranceSegmenter {
  constructor(channel) {
    this.channel = channel;
    this.chunks = [];
    this.preroll = [];
    this.speaking = false;
    this.silenceMs = 0;
    this.speechMs = 0;
    this.currentId = null;
    this.isContinuation = false; // segment continues a long statement
  }

  push(int16) {
    const ms = (int16.length / SAMPLE_RATE) * 1000;
    const isSpeech = rmsInt16(int16) > VAD_THRESHOLD;

    if (!this.speaking) {
      this.preroll.push(int16);
      if (this.preroll.length > PREROLL_CHUNKS) this.preroll.shift();
      if (isSpeech) {
        this.speaking = true;
        this.chunks = [...this.preroll];
        this.preroll = [];
        this.speechMs = ms;
        this.silenceMs = 0;
        this.isContinuation = false;
        // Insert the placeholder IMMEDIATELY at speech start — that keeps
        // the transcript in speaking order even when transcriptions take
        // different amounts of time.
        this.currentId = crypto.randomUUID();
        renderTranscript({
          channel: this.channel,
          itemId: this.currentId,
          text: "🎙 speaking …",
          final: false,
        });
      }
      return;
    }

    this.chunks.push(int16);
    if (isSpeech) {
      this.speechMs += ms;
      this.silenceMs = 0;
    } else {
      this.silenceMs += ms;
      if (this.silenceMs >= SILENCE_END_MS) {
        this.flush();
        return;
      }
    }

    // Long statement: cut off a segment and transcribe it immediately
    // while the speaker keeps talking (the next segment continues)
    const totalMs =
      (this.chunks.reduce((a, c) => a + c.length, 0) / SAMPLE_RATE) * 1000;
    if (totalMs >= maxSegmentMs()) this.rollover();
  }

  // finish the segment but stay in speaking mode
  rollover() {
    const chunks = this.chunks;
    const itemId = this.currentId;
    this.chunks = [];
    this.speechMs = 0;
    this.isContinuation = true;

    this.currentId = crypto.randomUUID();
    renderTranscript({
      channel: this.channel,
      itemId: this.currentId,
      text: "🎙 speaking …",
      final: false,
    });

    this.send(chunks, itemId);
  }

  flush() {
    const chunks = this.chunks;
    const speechMs = this.speechMs;
    const itemId = this.currentId;
    const wasContinuation = this.isContinuation;
    this.speaking = false;
    this.chunks = [];
    this.speechMs = 0;
    this.silenceMs = 0;
    this.currentId = null;
    this.isContinuation = false;

    if (!itemId) return;

    // Never discard continuation segments — they contain the end of a
    // longer statement even if their speech portion is short
    if (!wasContinuation && speechMs < MIN_SPEECH_MS) {
      // too short — probably noise: remove the placeholder again
      renderTranscript({ channel: this.channel, itemId, text: "", final: true });
      return;
    }

    this.send(chunks, itemId);
  }

  send(chunks, itemId) {
    const total = chunks.reduce((a, c) => a + c.length, 0);
    if (!total) {
      renderTranscript({ channel: this.channel, itemId, text: "", final: true });
      return;
    }
    const merged = new Int16Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }

    renderTranscript({
      channel: this.channel,
      itemId,
      text: "… transcribing …",
      final: false,
    });
    api.transcribeUtterance(this.channel, itemId, new Uint8Array(merged.buffer));
  }
}

const segmenters = {
  me: new UtteranceSegmenter("me"),
  other: new UtteranceSegmenter("other"),
};

// ---------------------------------------------------------------------------
// Audio capture (microphone + system loopback)
// ---------------------------------------------------------------------------

async function setupPipeline(stream, channel) {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  await ctx.audioWorklet.addModule("pcm-worklet.js");
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "pcm16-writer", {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
    channelCountMode: "explicit",
  });
  node.port.onmessage = (e) => {
    if (recording) segmenters[channel].push(new Int16Array(e.data));
  };
  source.connect(node);
  audioContexts.push(ctx);
  mediaStreams.push(stream);
}

async function startRecording() {
  if (!settings.legalAccepted) {
    openLegal();
    return;
  }
  if (!settings.replicateApiKey && !settings.hasEnvKey) {
    alert("Please add your Replicate API key in the settings first.");
    openSettings();
    return;
  }

  try {
    // system audio (loopback) — the other participants' voices
    const sysStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
    sysStream.getVideoTracks().forEach((t) => t.stop());

    // microphone — the interviewee's own voice
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    recording = true;
    await setupPipeline(sysStream, "other");
    await setupPipeline(micStream, "me");

    $("btnStart").disabled = true;
    $("btnStop").disabled = false;
    $("dotMe").className = "dot connected";
    $("dotOther").className = "dot connected";
    refreshConvBar(); // lock conversation management while recording
    companionLastOtherCount = otherUtteranceCount();
    updateCompanionTimer();
  } catch (err) {
    alert("Audio capture failed: " + err.message);
  }
}

async function stopRecording() {
  recording = false;
  clearTimeout(autoTriggerTimer);
  pendingOther = [];
  segmenters.me.flush();
  segmenters.other.flush();
  for (const ctx of audioContexts) {
    try { await ctx.close(); } catch {}
  }
  for (const s of mediaStreams) {
    s.getTracks().forEach((t) => t.stop());
  }
  audioContexts = [];
  mediaStreams = [];
  $("btnStart").disabled = false;
  $("btnStop").disabled = true;
  $("dotMe").className = "dot";
  $("dotOther").className = "dot";
  refreshConvBar();
  updateCompanionTimer();
  api.hideCompanionOverlay(); // interview over → close the overlay
}

$("btnStart").addEventListener("click", startRecording);
$("btnStop").addEventListener("click", stopRecording);

// ---------------------------------------------------------------------------
// Status + events
// ---------------------------------------------------------------------------

api.onTranscript(renderTranscript);

api.onSttStatus(({ channel, status, message }) => {
  const dot = channel === "me" ? $("dotMe") : $("dotOther");
  if (status === "error") {
    dot.className = "dot error";
    if (message) {
      console.error(`STT [${channel}]:`, message);
      addSystemNote(`Transcription failed: ${message}`);
    }
    setTimeout(() => {
      if (recording) dot.className = "dot connected";
    }, 3000);
  }
});

// ---------------------------------------------------------------------------
// Conversation management: save, browse, delete (only while not recording)
// ---------------------------------------------------------------------------

let convMetas = [];
let currentConvId = null;

function clearPanels() {
  transcriptEl.innerHTML = "";
  answersEl.innerHTML = "";
  utteranceEls.clear();
  answerEls.clear();
  history.length = 0;
  currentTopic = null;
  topicSuggestions = [];
}

function serializeConversation() {
  const transcript = [];
  for (const el of transcriptEl.children) {
    if (el.classList.contains("topic-divider")) {
      transcript.push({ channel: "topic", text: el.textContent.replace(/^📌\s*/, "") });
      continue;
    }
    if (
      !el.classList.contains("utterance") ||
      el.classList.contains("partial") ||
      el.classList.contains("note")
    )
      continue;
    transcript.push({
      channel: el.classList.contains("other") ? "other" : "me",
      text: el.querySelector(".body")?.textContent || "",
      question: el.classList.contains("question"),
    });
  }
  const answers = [];
  for (const el of answersEl.children) {
    if (el.classList.contains("topic-divider")) {
      answers.push({ question: "__topic__", text: el.textContent.replace(/^📌\s*/, "") });
      continue;
    }
    if (!el.classList.contains("answer")) continue;
    const a = el.querySelector(".a");
    answers.push({
      question: el.querySelector(".q")?.textContent || "",
      text: a?.dataset.raw ?? a?.textContent ?? "",
      deepening: el.classList.contains("deepening"),
    });
  }
  return { transcript, answers };
}

function restoreConversation(conv) {
  clearPanels();
  for (const u of conv.transcript || []) {
    if (u.channel === "topic") {
      transcriptEl.appendChild(topicDividerEl(u.text));
      currentTopic = u.text;
      continue;
    }
    const el = document.createElement("div");
    el.className = `utterance ${u.channel}${u.question ? " question" : ""}`;
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = u.channel === "other" ? "Interviewer" : "Me";
    const body = document.createElement("span");
    body.className = "body";
    body.textContent = u.text;
    el.append(who, body);
    transcriptEl.appendChild(el);
  }
  for (const a of conv.answers || []) {
    if (a.question === "__topic__") {
      answersEl.appendChild(topicDividerEl(a.text));
      continue;
    }
    const el = document.createElement("div");
    el.className = "answer";
    el.innerHTML = `<div class="q"></div><div class="a"></div>`;
    el.querySelector(".q").textContent = a.question; // already carries the ❓ prefix
    el.dataset.question = (a.question || "").replace(/^❓\s*/, "");
    if (a.deepening) {
      el.classList.add("deepening");
      addFlowTag(el, "↳ Follow-up");
    }
    const aEl = el.querySelector(".a");
    aEl.textContent = a.text;
    aEl.dataset.raw = a.text;
    answersEl.appendChild(el);
    renderRichContent(el);
    addAnswerActions(el);
  }
  rebuildHistory();
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  answersEl.scrollTop = answersEl.scrollHeight;
}

function convIndex() {
  return convMetas.findIndex((m) => m.id === currentConvId);
}

function refreshConvBar() {
  const idx = convIndex();
  const label = $("convLabel");
  if (currentConvId && idx !== -1) {
    const m = convMetas[idx];
    const when = new Date(m.updatedAt).toLocaleString("en-GB", {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    label.textContent = `${idx + 1}/${convMetas.length} — ${m.title} (${when})`;
  } else {
    label.textContent = convMetas.length
      ? `unsaved conversation — ${convMetas.length} saved`
      : "unsaved conversation";
  }

  $("btnConvSave").disabled = recording;
  $("btnConvNew").disabled = recording;
  $("btnConvDelete").disabled = recording || !currentConvId;
  $("btnConvPrev").disabled = recording || !convMetas.length;
  $("btnConvNext").disabled = recording || !convMetas.length;
}

function conversationTitle() {
  const firstOther = history.find((h) => h.speaker === "Interviewer");
  const src = (firstOther || history[0])?.text || "";
  return src ? src.slice(0, 48) : `Conversation from ${new Date().toLocaleString("en-GB")}`;
}

async function saveConversation() {
  if (recording) return;
  const { transcript, answers } = serializeConversation();
  if (!transcript.length && !answers.length) return;
  const res = await api.convSave({
    id: currentConvId,
    title: conversationTitle(),
    transcript,
    answers,
  });
  currentConvId = res.id;
  convMetas = res.metas;
  refreshConvBar();
}

async function loadConversationAt(idx) {
  if (recording || !convMetas.length) return;
  const clamped = ((idx % convMetas.length) + convMetas.length) % convMetas.length;
  const conv = await api.convGet(convMetas[clamped].id);
  if (!conv) return;
  currentConvId = conv.id;
  restoreConversation(conv);
  refreshConvBar();
}

function navConversation(delta) {
  const idx = convIndex();
  // starting from an unsaved conversation: begin at the newest one
  loadConversationAt(idx === -1 ? (delta > 0 ? 0 : convMetas.length - 1) : idx + delta);
}

$("btnConvSave").addEventListener("click", saveConversation);

$("btnConvNew").addEventListener("click", () => {
  if (recording) return;
  clearPanels();
  currentConvId = null;
  refreshConvBar();
});

$("btnConvPrev").addEventListener("click", () => navConversation(-1));
$("btnConvNext").addEventListener("click", () => navConversation(1));

$("btnConvDelete").addEventListener("click", async () => {
  if (recording || !currentConvId) return;
  if (!confirm("Delete this conversation permanently?")) return;
  const deletedIdx = convIndex();
  convMetas = await api.convDelete(currentConvId);
  currentConvId = null;
  clearPanels();
  if (convMetas.length) {
    await loadConversationAt(Math.min(deletedIdx, convMetas.length - 1));
  } else {
    refreshConvBar();
  }
});

// ---------------------------------------------------------------------------
// Cost display (estimate, provided by the main process)
// ---------------------------------------------------------------------------

api.onUsage(({ totalUsd, runs, unknownRuns }) => {
  $("cost").textContent = `≈ $${totalUsd.toFixed(4)}`;
  $("cost").title =
    `Estimated AI cost this session — ${runs} calls` +
    (unknownRuns ? ` (${unknownRuns} without pricing data)` : "");
});

// ---------------------------------------------------------------------------
// Legal notice
// ---------------------------------------------------------------------------

function openLegal() {
  $("legalDialog").showModal();
}

$("btnLegal").addEventListener("click", openLegal);

$("btnLegalAccept").addEventListener("click", async () => {
  settings = await api.saveSettings({ legalAccepted: true });
  $("legalDialog").close();
});

$("btnLegalDecline").addEventListener("click", () => {
  $("legalDialog").close();
});

// ---------------------------------------------------------------------------
// Settings including model selection
// ---------------------------------------------------------------------------

const RECOMMENDED_STT = [
  ["openai/gpt-4o-transcribe", "best accuracy"],
  ["vaibhavs10/incredibly-fast-whisper", "fastest"],
  ["victor-upmeet/whisperx", "with speaker labels"],
  ["openai/gpt-4o-mini-transcribe", "cheap + good"],
];

const RECOMMENDED_LLM = [
  ["anthropic/claude-4.5-haiku", "fast, recommended"],
  ["anthropic/claude-4.5-sonnet", "best quality"],
  ["openai/gpt-5-mini", "fast"],
  ["google/gemini-2.5-flash", "fast"],
];

const RECOMMENDED_VISION = [
  ["google/gemini-3-flash", "fastest, recommended"],
  ["anthropic/claude-4.5-sonnet", "best depth (UI, code, diagrams)"],
  ["openai/gpt-5.4", "most capable"],
  ["openai/gpt-5", "all-rounder"],
  ["openai/gpt-4o-mini", "cheap"],
  ["lucataco/moondream2", "open source"],
];

// most recently loaded collection lists (fallback until the first live fetch)
let modelLists = { stt: [], llm: [], vision: [] };

const CUSTOM_VALUE = "__custom__";

function populateModelSelect(selectId, customId, recommended, all, current) {
  const sel = $(selectId);
  sel.innerHTML = "";
  const seen = new Set();

  const gRec = document.createElement("optgroup");
  gRec.label = "Recommended";
  for (const [m, hint] of recommended) {
    if (seen.has(m)) continue;
    seen.add(m);
    gRec.appendChild(new Option(`${m} — ${hint}`, m));
  }
  sel.appendChild(gRec);

  const rest = (all || []).filter((m) => !seen.has(m));
  if (rest.length) {
    const gAll = document.createElement("optgroup");
    gAll.label = "All models";
    for (const m of rest) {
      seen.add(m);
      gAll.appendChild(new Option(m, m));
    }
    sel.appendChild(gAll);
  }

  // a saved model that is not (yet) part of the lists
  if (current && !seen.has(current)) {
    sel.insertBefore(new Option(`${current} (saved)`, current), sel.firstChild);
    seen.add(current);
  }

  sel.appendChild(new Option("Enter custom model …", CUSTOM_VALUE));

  sel.value = current && seen.has(current) ? current : sel.options[0].value;
  $(customId).classList.toggle("hidden", sel.value !== CUSTOM_VALUE);
}

function wireCustomToggle(selectId, customId) {
  $(selectId).addEventListener("change", () => {
    const isCustom = $(selectId).value === CUSTOM_VALUE;
    $(customId).classList.toggle("hidden", !isCustom);
    if (isCustom) $(customId).focus();
  });
}
wireCustomToggle("setSttModel", "setSttCustom");
wireCustomToggle("setAnswerModel", "setAnswerCustom");
wireCustomToggle("setVisionModel", "setVisionCustom");

function readModelChoice(selectId, customId, fallback) {
  const v = $(selectId).value;
  const chosen = v === CUSTOM_VALUE ? $(customId).value.trim() : v;
  return /^[\w.-]+\/[\w.-]+$/.test(chosen) ? chosen : fallback;
}

function refreshModelSelects() {
  populateModelSelect("setSttModel", "setSttCustom", RECOMMENDED_STT, modelLists.stt, settings.sttModel);
  populateModelSelect("setAnswerModel", "setAnswerCustom", RECOMMENDED_LLM, modelLists.llm, settings.answerModel);
  populateModelSelect("setVisionModel", "setVisionCustom", RECOMMENDED_VISION, modelLists.vision, settings.visionModel);
}

async function loadModelLists() {
  $("btnLoadModels").disabled = true;
  $("btnLoadModels").textContent = "loading ...";
  try {
    const { stt, llm, vision, live } = await api.listModels();
    modelLists = { stt, llm, vision };
    refreshModelSelects();
    $("btnLoadModels").textContent = live
      ? "Models loaded ✓"
      : "Default list (check API key)";
  } catch {
    $("btnLoadModels").textContent = "Loading failed";
  } finally {
    $("btnLoadModels").disabled = false;
    setTimeout(() => {
      $("btnLoadModels").textContent = "Refresh model list from Replicate";
    }, 2500);
  }
}

function openSettings() {
  $("setReplicate").value = settings.replicateApiKey || "";
  $("setReplicate").placeholder = settings.hasEnvKey
    ? "r8_... (empty = REPLICATE_API_TOKEN from environment)"
    : "r8_...";
  refreshModelSelects();
  $("setLanguage").value = settings.language ?? "en";
  $("setSegment").value = settings.maxSegmentSec ?? 1;
  $("setCompanionInterval").value = settings.companionIntervalSec ?? 20;
  $("setTopicConfirm").checked = !!settings.topicConfirm;
  populateDisplaySelect();
  $("setProfile").value = settings.profile || "";
  $("settingsDialog").showModal();
}

$("btnSettings").addEventListener("click", openSettings);
$("btnLoadModels").addEventListener("click", loadModelLists);

$("settingsDialog").addEventListener("close", async () => {
  if ($("settingsDialog").returnValue !== "save") return;
  settings = await api.saveSettings({
    replicateApiKey: $("setReplicate").value.trim(),
    sttModel: readModelChoice("setSttModel", "setSttCustom", settings.sttModel),
    answerModel: readModelChoice("setAnswerModel", "setAnswerCustom", settings.answerModel),
    visionModel: readModelChoice("setVisionModel", "setVisionCustom", settings.visionModel),
    language: $("setLanguage").value,
    maxSegmentSec: parseFloat($("setSegment").value) || 1,
    companionIntervalSec: parseFloat($("setCompanionInterval").value) || 20,
    companionDisplayId: parseInt($("setCompanionDisplay").value, 10) || null,
    topicConfirm: $("setTopicConfirm").checked,
    profile: $("setProfile").value.trim(),
  });
  updateCompanionTimer();
});

async function populateDisplaySelect() {
  const sel = $("setCompanionDisplay");
  sel.innerHTML = "";
  try {
    const displays = await api.listDisplays();
    for (const d of displays) {
      sel.appendChild(new Option(d.label, String(d.id)));
    }
    const saved = String(settings.companionDisplayId ?? "");
    if ([...sel.options].some((o) => o.value === saved)) sel.value = saved;
  } catch {}
}

$("chkPin").addEventListener("change", (e) => {
  api.setAlwaysOnTop(e.target.checked);
});

$("chkAuto").addEventListener("change", async (e) => {
  settings = await api.saveSettings({ autoAnswer: e.target.checked });
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

(async () => {
  settings = await api.getSettings();
  $("chkAuto").checked = !!settings.autoAnswer;
  $("chkPin").checked = !!settings.alwaysOnTop;
  $("chkCompanion").checked = !!settings.companionMode;

  // load the model lists (live from Replicate, otherwise the default list)
  try {
    const { stt, llm, vision } = await api.listModels();
    modelLists = { stt, llm, vision };
  } catch {}
  refreshModelSelects();

  // list saved conversations
  try {
    convMetas = await api.convList();
  } catch {}
  refreshConvBar();

  if (!settings.legalAccepted) {
    openLegal();
  } else if (!settings.replicateApiKey && !settings.hasEnvKey) {
    openSettings();
  }
})();

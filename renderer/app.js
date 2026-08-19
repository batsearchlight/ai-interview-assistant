/* global api */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let settings = null;
let recording = false;
let audioContexts = [];
let mediaStreams = [];

// Transkript-Historie fuer den LLM-Kontext
const history = []; // { speaker: "Interviewer" | "Ich", text }
const MAX_HISTORY = 24;

const $ = (id) => document.getElementById(id);

const transcriptEl = $("transcript");
const answersEl = $("answers");

// ---------------------------------------------------------------------------
// Fragenerkennung (Deutsch + Englisch)
// ---------------------------------------------------------------------------

const QUESTION_STARTS = [
  // Deutsch
  "was ", "wie ", "warum", "wieso", "weshalb", "wann ", "wo ", "wer ",
  "welche", "womit", "wodurch", "wofuer", "wofür", "koennen sie", "können sie",
  "kannst du", "haben sie", "hast du", "erzaehlen sie", "erzählen sie",
  "erzaehl ", "erzähl ", "erklaeren sie", "erklären sie", "erklaer ", "erklär ",
  "beschreiben sie", "beschreib ", "nennen sie", "nenn ",
  // Englisch
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
// Transkript-Rendering
// ---------------------------------------------------------------------------

// pro (channel, itemId) ein Element; Platzhalter bis das Ergebnis da ist
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
    who.textContent = channel === "other" ? "Interviewer" : "Ich";
    const body = document.createElement("span");
    body.className = "body";
    el.append(who, body);
    transcriptEl.appendChild(el);
    utteranceEls.set(key, el);
  }

  const body = el.querySelector(".body");

  if (final) {
    // Leere Transkription (Stille/Fehlschlag): Platzhalter entfernen
    if (!text.trim()) {
      el.remove();
      utteranceEls.delete(key);
      return;
    }

    body.textContent = text;
    el.classList.remove("partial");

    // Historie aus der Anzeige-Reihenfolge neu aufbauen — Transkriptionen
    // koennen in anderer Reihenfolge fertig werden, als gesprochen wurde.
    rebuildHistory();

    if (channel === "other") {
      const isQuestion = looksLikeQuestion(text);
      if (isQuestion) el.classList.add("question");
      // JEDE substanzielle Interviewer-Aussage geht (gebuendelt) zur
      // KI-Einordnung — [KEINE_AKTION] filtert Nicht-Fragen heraus.
      // So werden auch Fragen ohne Fragezeichen und in Segmente zerhackte
      // Fragen erkannt ("So, Angular Directives." / "Erzaehlen Sie mal ...").
      queueAutoTrigger(text, isQuestion);
    }
  } else {
    body.textContent = text;
  }

  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// LLM-Kontext immer in der Reihenfolge, in der die Aeusserungen im
// Transkript stehen (= Sprechbeginn), nicht in Fertigstellungs-Reihenfolge
function rebuildHistory() {
  history.length = 0;
  const els = transcriptEl.querySelectorAll(".utterance:not(.partial):not(.note)");
  for (const el of els) {
    const speaker = el.classList.contains("other") ? "Interviewer" : "Ich";
    const text = el.querySelector(".body")?.textContent || "";
    if (text) history.push({ speaker, text });
  }
  while (history.length > MAX_HISTORY) history.shift();
}

// Sichtbare Hinweiszeile im Transkript (z. B. bei Transkriptionsfehlern)
let lastNote = { text: "", time: 0 };
function addSystemNote(msg) {
  const now = Date.now();
  if (msg === lastNote.text && now - lastNote.time < 10000) return; // Spam-Schutz
  lastNote = { text: msg, time: now };
  const el = document.createElement("div");
  el.className = "utterance note";
  el.textContent = `⚠ ${msg}`;
  transcriptEl.appendChild(el);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// Antworten
// ---------------------------------------------------------------------------

const answerEls = new Map();

// --- Themenverlauf: die KI ordnet jede Interviewer-Aussage per Steuerzeile
// ein ([THEMA: ...] / [VERTIEFUNG] / [KEINE_AKTION]) — hier der Zustand dazu
let currentTopic = null;
let topicSuggestions = []; // bisherige Vorschlaege zum aktuellen Thema

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

// Steuerzeile auswerten → "removed" | "handled" | "raw"
function applyFlowControl(el, firstLine, id) {
  const mTopic = firstLine.match(/^\[?THEMA:?\s*(.+?)\]?\s*$/i);
  if (/KEINE_AKTION/i.test(firstLine)) {
    removeAnswerCard(id, el);
    return "removed";
  }
  if (mTopic && /THEMA/i.test(firstLine)) {
    const name = mTopic[1].replace(/[\[\]]/g, "").trim();
    // gleiches Thema erneut gemeldet → kein neuer Marker, als Vertiefung zeigen
    if (currentTopic && name.toLowerCase() === currentTopic.toLowerCase()) {
      el.classList.add("deepening");
      addFlowTag(el, `↳ Vertiefung — ${currentTopic}`);
      return "handled";
    }
    setTopic(name, el);
    addFlowTag(el, `📌 Neues Thema: ${currentTopic}`);
    return "handled";
  }
  if (/VERTIEFUNG/i.test(firstLine)) {
    el.classList.add("deepening");
    addFlowTag(el, `↳ Vertiefung${currentTopic ? ` — ${currentTopic}` : ""}`);
    return "handled";
  }
  return "raw"; // keine Steuerzeile erkannt → alles anzeigen
}

function askQuestion(question) {
  // Kontext klein halten (schnellere Antwort), ohne die aktuelle Frage selbst
  const ctx = history.slice(0, -1).slice(-8);
  api.generateAnswer(question, ctx, {
    topic: currentTopic,
    suggestions: topicSuggestions.slice(-3),
  });
}

// --- Auto-Trigger: Interviewer-Aeusserungen buendeln und einordnen lassen ---
// Erkannte Fragen feuern sofort; alles andere nach kurzer Redepause, damit
// in Segmente zerhackte Aussagen als Ganzes bei der KI ankommen.

let pendingOther = [];
let autoTriggerTimer = null;
const AUTO_TRIGGER_DEBOUNCE_MS = 1800;
const AUTO_TRIGGER_MIN_CHARS = 12;

function queueAutoTrigger(text, isQuestion) {
  if (!$("chkCompanion").checked && !$("chkAuto").checked) return;
  pendingOther.push(text);
  clearTimeout(autoTriggerTimer);
  // Companion Mode: IMMER kurz warten — der Interviewer praezisiert seine
  // Frage oft noch direkt nach dem Fragezeichen. Die Wartezeit sammelt die
  // Praezisierung mit ein, statt eine voreilige Antwort einzublenden.
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
  if (statement.length < AUTO_TRIGGER_MIN_CHARS) return; // "Ja.", "Mhm." etc.
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
  // Antwort-Karten warten erst auf die Steuerzeile der KI
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
      // KEINE_AKTION kann ohne Zeilenumbruch kommen
      if (/\[KEINE_AKTION\]/i.test(el._buf)) removeAnswerCard(id, el);
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

  // Stream endete, bevor eine Steuerzeile aufgeloest wurde
  if (el.dataset.ctl === "wait") {
    const buf = (el._buf || "").trim();
    el.dataset.ctl = "done";
    if (!buf || /KEINE_AKTION/i.test(buf)) {
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
  // Rohtext sichern (Rich-Rendering ersetzt gleich den DOM-Inhalt)
  const a = el.querySelector(".a");
  a.dataset.raw = a.textContent;
  renderRichContent(el);
  addAnswerActions(el);

  // fertige Vorschlaege dem aktuellen Thema zuordnen (fuer die naechste Einordnung)
  if (el.dataset.kind === "answer") {
    topicSuggestions.push(a.dataset.raw);
    if (topicSuggestions.length > 6) topicSuggestions.shift();
  }
});

// ---------------------------------------------------------------------------
// Follow-up-Buttons auf Antwort-Karten
// ---------------------------------------------------------------------------

const FOLLOWUP_BUTTONS = [
  ["elaborate", "➕ Mehr", "Etwas mehr Detail zu dieser Antwort"],
  ["code", "</> Code", "Kleines Code-Beispiel mit Highlighting"],
  ["proscons", "⚖ Pro/Kontra", "Kompakte Pro- und Kontra-Liste"],
  ["examples", "🧩 Beispiele", "2-3 konkrete Beispiele"],
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
// Mermaid-Rendering (```mermaid Codebloecke in fertigen Antworten)
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

// Fenced-Code-Bloecke rendern: ```mermaid als Diagramm, alles andere als
// syntax-gehighlighteter Code-Schnipsel (highlight.js, lokal gebundelt)
async function renderRichContent(answerEl) {
  const a = answerEl.querySelector(".a");
  const raw = a.dataset.raw ?? a.textContent;
  if (!raw.includes("```")) return;

  // split mit 2 Capture-Gruppen → [Text, Sprache, Code, Text, Sprache, Code, ...]
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
      i++; // Code-Teil mitkonsumieren

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
// Screenshot-Analyse
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Companion Mode: Verlauf periodisch (und bei Fragen) pruefen lassen;
// hilfreiche Notizen erscheinen als Overlay auf dem gewaehlten Display
// ---------------------------------------------------------------------------

let companionTimer = null;
let companionBusy = false;
let companionLastOtherCount = 0;

// Nur neue INTERVIEWER-Aeusserungen zaehlen — die eigene Antwort darf keine
// neuen Einblendungen ausloesen (Stabilitaet des Gespraechsfadens)
function otherUtteranceCount() {
  return history.filter((h) => h.speaker === "Interviewer").length;
}

// Statische Antwort-Karte (fuer Companion-Ergebnisse, die nicht streamen)
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
          flowtag: `📌 Neues Thema: ${res.topic}`,
        });
      } else {
        // gleiches/unbenanntes Thema → als normale Notiz ohne neuen Marker
        addStaticAnswerCard("🤖 Companion", res.text, {
          deepening: !!sameTopic,
          flowtag: sameTopic ? `↳ Vertiefung — ${currentTopic}` : null,
        });
      }
      topicSuggestions.push(res.text);
    } else if (res && res.action === "deep" && !isDuplicate) {
      addStaticAnswerCard("🤖 Companion", res.text, {
        deepening: true,
        flowtag: `↳ Vertiefung${currentTopic ? ` — ${currentTopic}` : ""}`,
      });
      topicSuggestions.push(res.text);
    }
    // "done" → Overlay ausgeblendet; "none" → nichts;
    // "pending" → Themenwechsel wartet auf Bestaetigung im Overlay
  } catch {}
  companionBusy = false;

  // Hat der Interviewer WAEHREND des Checks weitergesprochen (Frage
  // praezisiert), sofort mit aktualisiertem Verlauf nachpruefen — die KI
  // korrigiert dann ggf. per "↳ Praezisiert"-Block.
  if (
    recording &&
    $("chkCompanion").checked &&
    otherUtteranceCount() !== companionLastOtherCount
  ) {
    setTimeout(() => companionTick(true), 500);
  }
}

// Vom User bestaetigter Themenwechsel (Overlay-Button "Wechseln")
api.onCompanionTopicAccepted(({ topic, text }) => {
  setTopic(topic);
  addStaticAnswerCard("🤖 Companion", text, {
    flowtag: `📌 Neues Thema: ${topic}`,
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
// Schnell-Tipp (nur Gespraechsverlauf, ohne erkannte Frage)
// ---------------------------------------------------------------------------

function requestQuickTip() {
  if (!history.length) return;
  api.quickTip(history.slice(-14));
}

$("btnTip").addEventListener("click", requestQuickTip);

// Strg+T als Schnellzugriff, solange das Fenster fokussiert ist
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

// Manuelle Frage
$("btnAsk").addEventListener("click", () => {
  const input = $("manualQuestion");
  let q = input.value.trim();
  if (!q) {
    // Letzte Partner-Aussage als Frage verwenden
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
// Sprach-Segmentierung (einfacher Energie-VAD)
// ---------------------------------------------------------------------------
// Der AudioWorklet liefert Int16-Bloecke @16 kHz (2048 Samples = 128 ms).
// Eine Aeusserung beginnt bei Ueberschreiten der Energie-Schwelle und endet
// nach SILENCE_END_MS Stille. Fertige Aeusserungen gehen als PCM an den
// Main-Prozess und werden dort ueber Replicate transkribiert.

const SAMPLE_RATE = 16000;
const VAD_THRESHOLD = 450;   // RMS auf Int16
const SILENCE_END_MS = 600;
const MIN_SPEECH_MS = 350;
const PREROLL_CHUNKS = 3;

// Bei langem Sprechen wird alle N Sekunden ein Segment abgeschnitten und
// sofort transkribiert (konfigurierbar in den Einstellungen)
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
    this.isContinuation = false; // Segment ist Fortsetzung eines langen Beitrags
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
        // Platzhalter SOFORT bei Sprechbeginn einfuegen — so bleibt die
        // Reihenfolge im Transkript die Sprech-Reihenfolge, auch wenn
        // Transkriptionen unterschiedlich lange brauchen.
        this.currentId = crypto.randomUUID();
        renderTranscript({
          channel: this.channel,
          itemId: this.currentId,
          text: "🎙 spricht …",
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

    // Langer Redebeitrag: Segment abschneiden und sofort transkribieren,
    // waehrend der Sprecher weiterredet (naechstes Segment laeuft weiter)
    const totalMs =
      (this.chunks.reduce((a, c) => a + c.length, 0) / SAMPLE_RATE) * 1000;
    if (totalMs >= maxSegmentMs()) this.rollover();
  }

  // Segment abschliessen, aber im Sprech-Modus bleiben
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
      text: "🎙 spricht …",
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

    // Fortsetzungs-Segmente nie verwerfen — sie enthalten das Ende eines
    // laengeren Beitrags, auch wenn der Sprachanteil im Segment kurz ist
    if (!wasContinuation && speechMs < MIN_SPEECH_MS) {
      // zu kurz — vermutlich Geraeusch: Platzhalter wieder entfernen
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
      text: "… transkribiere …",
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
// Audio-Aufnahme (Mikrofon + System-Loopback)
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
    alert("Bitte zuerst den Replicate API-Key in den Einstellungen hinterlegen.");
    openSettings();
    return;
  }

  try {
    // System-Audio (Loopback) — Stimme der Gespraechspartner
    const sysStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
    sysStream.getVideoTracks().forEach((t) => t.stop());

    // Mikrofon — eigene Stimme
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
    refreshConvBar(); // Gespraechs-Verwaltung waehrend der Aufnahme sperren
    companionLastOtherCount = otherUtteranceCount();
    updateCompanionTimer();
  } catch (err) {
    alert("Audio-Aufnahme fehlgeschlagen: " + err.message);
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
  api.hideCompanionOverlay(); // Interview vorbei → Einblendung schliessen
}

$("btnStart").addEventListener("click", startRecording);
$("btnStop").addEventListener("click", stopRecording);

// ---------------------------------------------------------------------------
// Status + Events
// ---------------------------------------------------------------------------

api.onTranscript(renderTranscript);

api.onSttStatus(({ channel, status, message }) => {
  const dot = channel === "me" ? $("dotMe") : $("dotOther");
  if (status === "error") {
    dot.className = "dot error";
    if (message) {
      console.error(`STT [${channel}]:`, message);
      addSystemNote(`Transkription fehlgeschlagen: ${message}`);
    }
    setTimeout(() => {
      if (recording) dot.className = "dot connected";
    }, 3000);
  }
});

// ---------------------------------------------------------------------------
// Gespraechs-Verwaltung: speichern, blaettern, loeschen (nur ohne Aufnahme)
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
    who.textContent = u.channel === "other" ? "Interviewer" : "Ich";
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
    el.querySelector(".q").textContent = a.question; // enthaelt bereits das ❓-Praefix
    el.dataset.question = (a.question || "").replace(/^❓\s*/, "");
    if (a.deepening) {
      el.classList.add("deepening");
      addFlowTag(el, "↳ Vertiefung");
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
    const when = new Date(m.updatedAt).toLocaleString("de-DE", {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    label.textContent = `${idx + 1}/${convMetas.length} — ${m.title} (${when})`;
  } else {
    label.textContent = convMetas.length
      ? `ungespeichertes Gespraech — ${convMetas.length} gespeichert`
      : "ungespeichertes Gespraech";
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
  return src ? src.slice(0, 48) : `Gespraech vom ${new Date().toLocaleString("de-DE")}`;
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
  // aus einem ungespeicherten Gespraech heraus: beim neuesten anfangen
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
  if (!confirm("Dieses Gespraech endgueltig loeschen?")) return;
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
// Kosten-Anzeige (Schaetzung, kommt vom Main-Prozess)
// ---------------------------------------------------------------------------

api.onUsage(({ totalUsd, runs, unknownRuns }) => {
  $("cost").textContent = `≈ $${totalUsd.toFixed(4)}`;
  $("cost").title =
    `Geschaetzte KI-Kosten dieser Session — ${runs} Aufrufe` +
    (unknownRuns ? ` (davon ${unknownRuns} ohne Preisdaten)` : "");
});

// ---------------------------------------------------------------------------
// Rechtlicher Hinweis
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
// Einstellungen inkl. Modell-Auswahl
// ---------------------------------------------------------------------------

const RECOMMENDED_STT = [
  ["openai/gpt-4o-transcribe", "beste Genauigkeit"],
  ["vaibhavs10/incredibly-fast-whisper", "am schnellsten"],
  ["victor-upmeet/whisperx", "mit Sprecher-Labels"],
  ["openai/gpt-4o-mini-transcribe", "guenstig + gut"],
];

const RECOMMENDED_LLM = [
  ["anthropic/claude-4.5-haiku", "schnell, empfohlen"],
  ["anthropic/claude-4.5-sonnet", "beste Qualitaet"],
  ["openai/gpt-5-mini", "schnell"],
  ["google/gemini-2.5-flash", "schnell"],
];

const RECOMMENDED_VISION = [
  ["google/gemini-3-flash", "am schnellsten, empfohlen"],
  ["anthropic/claude-4.5-sonnet", "beste Tiefe (UI, Code, Diagramme)"],
  ["openai/gpt-5.4", "am faehigsten"],
  ["openai/gpt-5", "Allrounder"],
  ["openai/gpt-4o-mini", "guenstig"],
  ["lucataco/moondream2", "Open Source"],
];

// zuletzt geladene Collection-Listen (Fallback bis zum ersten Live-Abruf)
let modelLists = { stt: [], llm: [], vision: [] };

const CUSTOM_VALUE = "__custom__";

function populateModelSelect(selectId, customId, recommended, all, current) {
  const sel = $(selectId);
  sel.innerHTML = "";
  const seen = new Set();

  const gRec = document.createElement("optgroup");
  gRec.label = "Empfohlen";
  for (const [m, hint] of recommended) {
    if (seen.has(m)) continue;
    seen.add(m);
    gRec.appendChild(new Option(`${m} — ${hint}`, m));
  }
  sel.appendChild(gRec);

  const rest = (all || []).filter((m) => !seen.has(m));
  if (rest.length) {
    const gAll = document.createElement("optgroup");
    gAll.label = "Alle Modelle";
    for (const m of rest) {
      seen.add(m);
      gAll.appendChild(new Option(m, m));
    }
    sel.appendChild(gAll);
  }

  // gespeichertes Modell, das (noch) nicht in den Listen steht
  if (current && !seen.has(current)) {
    sel.insertBefore(new Option(`${current} (gespeichert)`, current), sel.firstChild);
    seen.add(current);
  }

  sel.appendChild(new Option("Eigenes Modell eingeben …", CUSTOM_VALUE));

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
  $("btnLoadModels").textContent = "lade ...";
  try {
    const { stt, llm, vision, live } = await api.listModels();
    modelLists = { stt, llm, vision };
    refreshModelSelects();
    $("btnLoadModels").textContent = live
      ? "Modelle geladen ✓"
      : "Standard-Liste (Key pruefen)";
  } catch {
    $("btnLoadModels").textContent = "Fehler beim Laden";
  } finally {
    $("btnLoadModels").disabled = false;
    setTimeout(() => {
      $("btnLoadModels").textContent = "Modell-Liste von Replicate aktualisieren";
    }, 2500);
  }
}

function openSettings() {
  $("setReplicate").value = settings.replicateApiKey || "";
  $("setReplicate").placeholder = settings.hasEnvKey
    ? "r8_... (leer = REPLICATE_API_TOKEN aus Umgebung)"
    : "r8_...";
  refreshModelSelects();
  $("setLanguage").value = settings.language ?? "de";
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

  // Auswahllisten laden (live von Replicate, sonst Standard-Liste)
  try {
    const { stt, llm, vision } = await api.listModels();
    modelLists = { stt, llm, vision };
  } catch {}
  refreshModelSelects();

  // gespeicherte Gespraeche auflisten
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

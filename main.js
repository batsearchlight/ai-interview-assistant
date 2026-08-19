const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  desktopCapturer,
  screen,
} = require("electron");
const path = require("path");
const fs = require("fs");

let win = null;
let overlayWin = null;

// ---------------------------------------------------------------------------
// Settings (JSON-Datei im userData-Verzeichnis)
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  replicateApiKey: "",
  sttModel: "openai/gpt-4o-mini-transcribe",
  answerModel: "anthropic/claude-4.5-haiku",
  visionModel: "google/gemini-3-flash",
  language: "de",
  maxSegmentSec: 1, // lange Redebeitraege alle N Sekunden zerteilen
  autoAnswer: true,
  companionMode: false,
  companionIntervalSec: 20,
  companionDisplayId: null, // Display fuer die Overlay-Einblendung
  topicConfirm: false, // Themenwechsel im Companion erst nach Bestaetigung
  alwaysOnTop: true,
  legalAccepted: false,
  captureRegion: null, // { displayId, x, y, width, height } (DIP, relativ zum Display)
  profile:
    "Bewerber:in fuer eine Softwareentwickler-Stelle. Erfahrung mit JavaScript, TypeScript und Web-Entwicklung.",
};

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

// Replicate-Modelle heissen immer "owner/name" — alles andere (z. B. Reste
// aus einer aelteren App-Version) wird auf die Defaults zurueckgesetzt.
const MODEL_RE = /^[\w.-]+\/[\w.-]+$/;

function sanitizeModels(s) {
  if (!MODEL_RE.test(s.sttModel || "")) s.sttModel = DEFAULT_SETTINGS.sttModel;
  if (!MODEL_RE.test(s.answerModel || "")) s.answerModel = DEFAULT_SETTINGS.answerModel;
  if (!MODEL_RE.test(s.visionModel || "")) s.visionModel = DEFAULT_SETTINGS.visionModel;
  return s;
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), "utf8");
    return sanitizeModels({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function persistSettings(s) {
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2), "utf8");
}

let settings;

function apiKey() {
  return settings.replicateApiKey || process.env.REPLICATE_API_TOKEN || "";
}

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------------------
// Kosten-Tracking (Schaetzung fuer die laufende Session)
// ---------------------------------------------------------------------------

// Grobe Preisliste (USD). Token-Modelle: [Input, Output] pro Million Tokens;
// Audio-Modelle: pro Audio-Minute. Nicht gelistete Modelle werden als
// "ohne Preisdaten" gezaehlt.
const PRICING = {
  tokenModels: {
    "anthropic/claude-4.5-haiku": [1, 5],
    "anthropic/claude-4.5-sonnet": [3, 15],
    "anthropic/claude-opus-4.6": [5, 25],
    "openai/gpt-5-mini": [0.25, 2],
    "openai/gpt-5": [1.25, 10],
    "openai/gpt-5.4": [1.75, 14],
    "openai/gpt-4o-mini": [0.15, 0.6],
    "openai/gpt-4o": [2.5, 10],
    "google/gemini-3-flash": [0.5, 3],
    "google/gemini-2.5-flash": [0.3, 2.5],
    "deepseek-ai/deepseek-v3.1": [0.27, 1.1],
  },
  audioModels: {
    "openai/gpt-4o-mini-transcribe": 0.003,
    "openai/gpt-4o-transcribe": 0.006,
  },
  // Community-STT: GPU-Rechenzeit, USD pro Sekunde predict_time
  audioPerSecond: {
    "openai/whisper": 0.000725,
    "vaibhavs10/incredibly-fast-whisper": 0.000975,
    "victor-upmeet/whisperx": 0.000975,
  },
};

const usage = { totalUsd: 0, runs: 0, unknownRuns: 0 };

function addUsage(usd) {
  usage.runs++;
  if (usd == null) usage.unknownRuns++;
  else usage.totalUsd += usd;
  sendToRenderer("usage-update", { ...usage });
}

function trackLlmCost(model, metrics, promptChars, outputChars) {
  const p = PRICING.tokenModels[model];
  if (!p) return addUsage(null);
  // echte Token-Zahlen aus den Prediction-Metrics, sonst ~4 Zeichen/Token
  const tIn = metrics?.input_token_count ?? Math.ceil(promptChars / 4);
  const tOut = metrics?.output_token_count ?? Math.ceil(outputChars / 4);
  addUsage((tIn * p[0] + tOut * p[1]) / 1e6);
}

// ---------------------------------------------------------------------------
// Replicate-HTTP-Helfer
// ---------------------------------------------------------------------------

const REPLICATE_BASE = "https://api.replicate.com/v1";

function repHeaders(extra = {}) {
  return { Authorization: `Bearer ${apiKey()}`, ...extra };
}

async function repJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: repHeaders(options.headers || {}),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body.detail || body.title || JSON.stringify(body);
    } catch {}
    throw new Error(`Replicate HTTP ${res.status}${detail ? ": " + detail : ""}`);
  }
  return res.json();
}

// Modell-Schema einmalig laden und cachen, damit beliebige vom User gewaehlte
// Modelle funktionieren (Feldnamen fuer Audio/Bild/System-Prompt variieren).
const modelInfoCache = new Map();

async function getModelInfo(model) {
  if (modelInfoCache.has(model)) return modelInfoCache.get(model);

  const info = {
    audioField: "audio",
    imageField: null,
    imageIsArray: false,
    hasLanguage: false,
    languageEnum: null,
    systemField: null, // system_prompt | system_instruction
    maxTokensField: null, // max_tokens | max_new_tokens | max_output_tokens
    maxTokensMin: null,
    maxTokensMax: null,
    versionId: null, // fuer Community-Modelle (Version-basierte Predictions)
    useVersionEndpoint: false,
  };
  try {
    const data = await repJson(`${REPLICATE_BASE}/models/${model}`);
    const props =
      data?.latest_version?.openapi_schema?.components?.schemas?.Input
        ?.properties || {};

    const uriFields = [];
    const uriArrayFields = [];
    for (const [name, p] of Object.entries(props)) {
      if (p.format === "uri") uriFields.push(name);
      else if (p.type === "array" && p.items && p.items.format === "uri")
        uriArrayFields.push(name);
    }

    // Audio-Eingabefeld (URI-Feld, dessen Name nach Audio klingt)
    const audioField = uriFields.find((n) => /audio|voice|speech|file/i.test(n));
    if (audioField) info.audioField = audioField;

    // Bild-Eingabefeld: einzelne URI oder URI-Array
    const imgSingle = uriFields.find((n) => /image|img|photo|media/i.test(n));
    const imgArray = uriArrayFields.find((n) => /image|img|photo|media/i.test(n));
    if (imgSingle) {
      info.imageField = imgSingle;
    } else if (imgArray) {
      info.imageField = imgArray;
      info.imageIsArray = true;
    }

    info.versionId = data?.latest_version?.id || null;
    info.hasLanguage = "language" in props;
    if (info.hasLanguage && Array.isArray(props.language.enum)) {
      info.languageEnum = props.language.enum;
    }
    if ("system_prompt" in props) info.systemField = "system_prompt";
    else if ("system_instruction" in props) info.systemField = "system_instruction";
    if ("max_tokens" in props) info.maxTokensField = "max_tokens";
    else if ("max_new_tokens" in props) info.maxTokensField = "max_new_tokens";
    else if ("max_output_tokens" in props) info.maxTokensField = "max_output_tokens";
    if (info.maxTokensField) {
      const p = props[info.maxTokensField];
      if (typeof p.minimum === "number") info.maxTokensMin = p.minimum;
      if (typeof p.maximum === "number") info.maxTokensMax = p.maximum;
    }
  } catch {
    // Fallback-Heuristik bleibt bestehen
  }
  modelInfoCache.set(model, info);
  return info;
}

// Prediction-Output in Text umwandeln (Modelle liefern String, String-Array
// oder Objekte mit text/transcription-Feld)
function outputToText(output) {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map(outputToText).join("");
  if (typeof output === "object") {
    if (typeof output.text === "string") return output.text;
    if (typeof output.transcription === "string") return output.transcription;
    return "";
  }
  return String(output);
}

// 422-Validierungsfehler wie "input.max_tokens: Must be greater than or
// equal to 1024" automatisch korrigieren (Grenzwert aus der Meldung parsen)
function applyConstraintFix(body, message) {
  const m = message.match(
    /input\.(\w+):\s*Must be (greater|less) than or equal to (\d+(?:\.\d+)?)/i
  );
  if (!m) return null;
  const [, field, dir, valStr] = m;
  const limit = parseFloat(valStr);
  const cur = body.input?.[field];
  if (typeof cur !== "number") return null;

  const input = { ...body.input };
  if (/greater/i.test(dir) && cur < limit) input[field] = limit;
  else if (/less/i.test(dir) && cur > limit) input[field] = limit;
  else return null;
  return { ...body, input };
}

async function createPrediction(model, body, headers = {}) {
  try {
    return await createPredictionRaw(model, body, headers);
  } catch (err) {
    if (/HTTP 422/.test(err.message)) {
      const fixed = applyConstraintFix(body, err.message);
      if (fixed) return createPredictionRaw(model, fixed, headers);
    }
    throw err;
  }
}

// Prediction erzeugen: offizielle Modelle laufen ueber
// /models/{owner}/{name}/predictions, Community-Modelle nur ueber
// /predictions mit Versions-ID. Bei 404 automatisch umschalten (gecacht).
async function createPredictionRaw(model, body, headers = {}) {
  const info = await getModelInfo(model);
  const allHeaders = { "Content-Type": "application/json", ...headers };

  if (!info.useVersionEndpoint) {
    try {
      return await repJson(`${REPLICATE_BASE}/models/${model}/predictions`, {
        method: "POST",
        headers: allHeaders,
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (!/HTTP 404/.test(err.message) || !info.versionId) throw err;
      info.useVersionEndpoint = true; // ab jetzt direkt den Version-Endpoint
    }
  }

  if (!info.versionId) {
    throw new Error(`Replicate HTTP 404: Modell ${model} hat keine Version`);
  }
  return repJson(`${REPLICATE_BASE}/predictions`, {
    method: "POST",
    headers: allHeaders,
    body: JSON.stringify({ ...body, version: info.versionId }),
  });
}

// Sprachparameter an das Modell anpassen: manche Modelle erwarten
// ISO-Codes ("de"), andere Sprachnamen aus einem Enum ("german")
const LANGUAGE_NAMES = {
  de: "german",
  en: "english",
  hi: "hindi",
  zh: "chinese",
  ja: "japanese",
  es: "spanish",
  fr: "french",
};

// Anzeigename fuer die Prompts ("Antworte auf ...")
const LANGUAGE_LABELS = {
  de: "Deutsch",
  en: "Englisch",
  hi: "Hindi",
  zh: "Chinesisch",
  ja: "Japanisch",
  es: "Spanisch",
  fr: "Franzoesisch",
};

function answerLanguageRule() {
  const label = LANGUAGE_LABELS[settings.language];
  return label
    ? `- Antworte auf ${label}.`
    : "- Sprache der Antwort = Sprache der Frage.";
}

function resolveLanguage(info, code) {
  if (!info.languageEnum) return code;
  if (info.languageEnum.includes(code)) return code;
  const name = LANGUAGE_NAMES[code];
  if (name && info.languageEnum.includes(name)) return name;
  return null; // kein passender Wert — Parameter weglassen (Auto-Erkennung)
}

async function waitForPrediction(pred, timeoutMs = 90000) {
  const start = Date.now();
  let current = pred;
  while (current.status === "starting" || current.status === "processing") {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Replicate-Prediction Timeout");
    }
    await new Promise((r) => setTimeout(r, 600));
    current = await repJson(current.urls.get);
  }
  if (current.status !== "succeeded") {
    throw new Error(current.error || `Prediction ${current.status}`);
  }
  return current;
}

// Kleine Dateien als Data-URI, groessere ueber die Replicate Files API
async function bufferToUrl(buffer, mime, filename) {
  if (buffer.length <= 180 * 1024) {
    return `data:${mime};base64,${buffer.toString("base64")}`;
  }
  const form = new FormData();
  form.append("content", new Blob([buffer], { type: mime }), filename);
  const file = await repJson(`${REPLICATE_BASE}/files`, {
    method: "POST",
    body: form,
  });
  return file.urls.get;
}

// ---------------------------------------------------------------------------
// Transkription: WAV bauen, hochladen, Prediction ausfuehren
// ---------------------------------------------------------------------------

function pcm16ToWav(pcm, sampleRate = 16000) {
  const data = Buffer.from(pcm);
  const buf = Buffer.alloc(44 + data.length);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + data.length, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(data.length, 40);
  data.copy(buf, 44);
  return buf;
}

async function transcribeUtterance(channel, itemId, pcmBuffer) {
  try {
    const model = settings.sttModel;
    const info = await getModelInfo(model);
    const wav = pcm16ToWav(pcmBuffer);
    const audioUrl = await bufferToUrl(wav, "audio/wav", "utterance.wav");

    const input = { [info.audioField]: audioUrl };
    if (info.hasLanguage && settings.language) {
      const lang = resolveLanguage(info, settings.language);
      if (lang) input.language = lang;
    }

    const pred = await createPrediction(model, { input }, { Prefer: "wait=60" });
    const done = await waitForPrediction(pred);
    const text = outputToText(done.output).trim();

    sendToRenderer("transcript", { channel, itemId, text, final: true });

    // Kosten: pro Audio-Minute (offizielle Modelle) oder pro
    // Rechenzeit-Sekunde (Community-Modelle auf GPU-Hardware)
    const minutes = pcmBuffer.length / 2 / 16000 / 60;
    const perMin = PRICING.audioModels[model];
    const perSec = PRICING.audioPerSecond[model];
    if (perMin != null) addUsage(minutes * perMin);
    else if (perSec != null && done.metrics?.predict_time != null)
      addUsage(done.metrics.predict_time * perSec);
    else addUsage(null);
  } catch (err) {
    sendToRenderer("transcript", { channel, itemId, text: "", final: true });
    const msg = /404/.test(err.message)
      ? `Modell "${settings.sttModel}" wurde auf Replicate nicht gefunden (404). Bitte in den Einstellungen ein gueltiges Transkriptions-Modell waehlen.`
      : err.message;
    sendToRenderer("stt-status", { channel, status: "error", message: msg });
  }
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function buildSystemPrompt() {
  return [
    "Du bist ein Echtzeit-Interview-Assistent. Die interviewte Person liest deine Antwort WAEHREND sie spricht — sie hat nur 2-3 Sekunden zum Erfassen.",
    "",
    `Profil der interviewten Person: ${settings.profile}`,
    "",
    "Wichtig — fehlerhafte Transkription: Die Spracherkennung verstuemmelt oft Fachbegriffe (z. B. \"Angela directives\" statt \"Angular directives\", \"Kuba Netes\" statt \"Kubernetes\"). Rekonstruiere die GEMEINTEN Begriffe immer aus dem Gespraechskontext und dem Profil der interviewten Person.",
    "",
    "Ausgabeformat (strikt, keine Abweichung):",
    "Zeile 1: \"❓ \" + die von dir verstandene Frage, sauber umformuliert mit den rekonstruierten Fachbegriffen, maximal 10 Woerter.",
    "Danach die Antwort: 1-2 Stichpunkte mit \"- \", maximal 8 Woerter pro Punkt.",
    "Ein Punkt reicht meistens — nur bei Bedarf zwei.",
    "AUSNAHME: Verlangt die Frage erkennbar eine ausfuehrlichere Antwort (\"erklaeren Sie im Detail\", Vergleich, mehrteilige Frage), dann bis zu 4 Stichpunkte — aber weiterhin nur das Noetigste fuer eine korrekte Antwort.",
    "",
    "Regeln:",
    "- Gib NUR die Information, die gefordert ist — keine ungefragten Ergaenzungen, keine Extra-Tipps, kein Zusatzkontext.",
    "- Schluesselbegriffe statt Saetze. Konkrete Zahlen, Fachbegriffe, Namen.",
    "- Keine Fuellwoerter, keine Einleitung, keine Erklaerung, kein Meta-Kommentar.",
    "- Bei Ja/Nein-Fragen beginnt der erste Punkt mit \"Ja:\" oder \"Nein:\".",
    answerLanguageRule(),
    "",
    "Beispiel:",
    "❓ Warum sollten wir Sie einstellen?",
    "- 5 Jahre TypeScript, 3 Produktions-Apps",
    "- Staerke: schnelle Einarbeitung in fremden Code",
  ].join("\n");
}

function historyToText(history) {
  return history && history.length
    ? history.map((h) => `${h.speaker}: ${h.text}`).join("\n")
    : "(noch kein Gespraechsverlauf)";
}

function buildUserPrompt(question, history, flow = {}) {
  const parts = [];
  if (history && history.length) {
    parts.push(`Bisheriger Gespraechsverlauf (gekuerzt):\n${historyToText(history)}`);
  }
  parts.push(
    flow.topic
      ? `Aktuelles Interview-Thema: ${flow.topic}`
      : "Aktuelles Interview-Thema: noch keines erfasst."
  );
  if (flow.suggestions && flow.suggestions.length) {
    parts.push(
      `Deine bisherigen Antwortvorschlaege zum aktuellen Thema:\n${flow.suggestions.join("\n---\n")}`
    );
  }
  parts.push(
    `Aktuelle Aussage des Interviewers (Transkription, evtl. fehlerhaft): "${question}"`
  );
  parts.push(
    [
      "Interview-Ablauf: Frage → Antwort der interviewten Person → dann entweder vertiefende Nachfrage zum selben Thema ODER Wechsel zur naechsten Frage.",
      "Ordne die aktuelle Aussage ein und beginne deine Ausgabe mit GENAU EINER Steuerzeile:",
      "[THEMA: <Themenname, max 4 Woerter>] — neue Frage / neues Thema beginnt. Das gilt AUCH, wenn die Aussage keine grammatische Frage ist: ein in den Raum gestellter Fachbegriff (\"So, Angular Directives.\"), eine Aufforderung (\"Erzaehlen Sie mal ...\") oder ein erkennbarer Uebergang zur ersten/naechsten Interviewfrage zaehlen als neues Thema.",
      "[VERTIEFUNG] — weitergehende Nachfrage zum aktuellen Thema.",
      "[KEINE_AKTION] — kein neuer Vorschlag noetig: Frage ist durch deine bisherigen Vorschlaege bereits abgedeckt, oder es ist keine echte neue Frage (Bestaetigung, Weiterreden, Smalltalk).",
      "",
      "Nach [KEINE_AKTION]: Ausgabe sofort beenden, nichts weiter schreiben.",
      "Nach [THEMA: ...]: neue Zeile, dann ❓-Zeile + 1-2 ultrakurze Stichpunkte.",
      "Nach [VERTIEFUNG]: neue Zeile, dann ❓-Zeile (die Nachfrage) + 1-3 Stichpunkte mit AUSSCHLIESSLICH neuen Zusatzinfos, die deine bisherigen Vorschlaege ergaenzen — nichts wiederholen.",
    ].join("\n")
  );
  return parts.join("\n\n");
}

function buildVisionSystemPrompt() {
  return [
    "Du bist ein Echtzeit-Interview-Assistent mit Blick auf den Bildschirm der interviewten Person. Sie liest deine Ausgabe WAEHREND des Gespraechs — sie hat nur wenige Sekunden.",
    "Du erhaeltst einen Screenshot eines gewaehlten Bildschirmbereichs plus den juengsten Gespraechsverlauf. Entscheide selbst, was JETZT am meisten hilft.",
    "",
    "Ausgabeformat (strikt):",
    "- Maximal 5 Stichpunkte, beginnend mit \"- \", je maximal 8 Woerter.",
    "- Nur konkrete Fakten aus Screenshot + Gespraech: Zahlen, Anforderungen, Fehlermeldungen, Namen.",
    "- Das Wichtigste IMMER als ersten Stichpunkt.",
    "- Keine Einleitung, keine Bildbeschreibung, kein Meta-Kommentar, keine Fuellwoerter.",
    "- Optional GENAU EIN kleines Mermaid-Diagramm in einem ```mermaid Codeblock (flowchart TD oder LR, maximal 8 Knoten, Labels maximal 3 Woerter) — nur wenn Ablauf/Struktur visuell schneller erfassbar ist.",
    answerLanguageRule(),
  ].join("\n");
}

function buildVisionUserPrompt(history) {
  return [
    `Juengster Gespraechsverlauf:\n${historyToText(history)}`,
    "",
    "Analysiere den angehaengten Screenshot im Kontext dieses Gespraechs und zeige mir die hilfreichsten Informationen an.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// LLM-Aufrufe (SSE-Streaming mit Polling-Fallback)
// ---------------------------------------------------------------------------

async function streamSse(url, onDelta) {
  const res = await fetch(url, {
    headers: repHeaders({ Accept: "text/event-stream" }),
  });
  if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let sep;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const rawEvent = buf.slice(0, sep);
      buf = buf.slice(sep + 2);

      let eventType = "message";
      const dataLines = [];
      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("event:")) eventType = line.slice(6).trim();
        else if (line.startsWith("data:")) {
          // SSE: genau ein fuehrendes Leerzeichen nach "data:" entfernen
          let d = line.slice(5);
          if (d.startsWith(" ")) d = d.slice(1);
          dataLines.push(d);
        }
      }
      const data = dataLines.join("\n");

      if (eventType === "output") onDelta(data);
      else if (eventType === "error") throw new Error(data || "Stream-Fehler");
      else if (eventType === "done") return;
    }
  }
}

// Gewuenschtes Token-Limit setzen, aber an die Schema-Grenzen des Modells
// anpassen (manche Modelle verlangen z. B. mindestens 1024)
function setMaxTokens(input, info, desired) {
  if (!info.maxTokensField) return;
  let v = desired;
  if (info.maxTokensMin != null) v = Math.max(v, info.maxTokensMin);
  if (info.maxTokensMax != null) v = Math.min(v, info.maxTokensMax);
  input[info.maxTokensField] = v;
}

// Summe aller String-Felder eines Inputs (fuer die Token-Schaetzung),
// ohne Data-URIs (Bilder/Audio) mitzuzaehlen
function promptCharsOf(input) {
  let chars = 0;
  for (const v of Object.values(input)) {
    if (typeof v === "string" && !v.startsWith("data:") && !v.startsWith("http")) {
      chars += v.length;
    }
  }
  return chars;
}

// Prediction ausfuehren, Deltas an onDelta liefern, Gesamttext zurueckgeben
async function runPrediction(model, input, onDelta) {
  const pred = await createPrediction(model, { input, stream: true });

  let full = "";
  let metrics = null;

  if (pred.urls && pred.urls.stream) {
    await streamSse(pred.urls.stream, (delta) => {
      full += delta;
      if (onDelta) onDelta(delta);
    });
    // Metrics (echte Token-Zahlen) nach Stream-Ende nachladen
    try {
      metrics = (await repJson(pred.urls.get)).metrics || null;
    } catch {}
  } else {
    const done = await waitForPrediction(pred, 180000);
    full = outputToText(done.output);
    metrics = done.metrics || null;
    if (onDelta) onDelta(full);
  }

  trackLlmCost(model, metrics, promptCharsOf(input), full.length);
  return full;
}

async function runStreamingPrediction(model, input, answerId) {
  await runPrediction(model, input, (delta) =>
    sendToRenderer("answer-delta", { id: answerId, text: delta })
  );
  sendToRenderer("answer-done", { id: answerId });
}

async function generateAnswer(question, history, flow, answerId) {
  const model = settings.answerModel;
  const info = await getModelInfo(model);

  const input = {};
  if (info.systemField) {
    input.prompt = buildUserPrompt(question, history, flow);
    input[info.systemField] = buildSystemPrompt();
  } else {
    input.prompt = `${buildSystemPrompt()}\n\n---\n\n${buildUserPrompt(question, history, flow)}`;
  }
  // Obergrenze, kein Ziel — die Kuerze erzwingt der Prompt. 1024 erfuellt
  // zugleich das Minimum, das manche Modelle serverseitig verlangen.
  setMaxTokens(input, info, 1024);

  await runStreamingPrediction(model, input, answerId);
}

// Schnell-Tipp: nur der Gespraechsverlauf, kein explizites Frage-Ziel.
// Das Modell entscheidet selbst, was gerade am meisten hilft.
function buildQuickTipPrompt(history) {
  return [
    `Juengster Gespraechsverlauf:\n${historyToText(history)}`,
    "",
    "Kein expliziter Trigger — die interviewte Person hat manuell um Hilfe gebeten.",
    "Entscheide selbst, was JETZT am meisten hilft, genau eines davon:",
    "a) Antwortvorschlag auf die zuletzt offene Frage/Aussage des Interviewers,",
    "b) taktischer Tipp (z. B. Rueckfrage stellen, Beispiel bringen, Punkt vertiefen),",
    "c) das eine Detail/Argument, das in der Situation noch fehlt.",
    "",
    "Antworte im vorgegebenen Format: ❓-Zeile (worauf du dich beziehst), dann 1-2 ultrakurze Stichpunkte.",
  ].join("\n");
}

async function generateQuickTip(history, answerId) {
  const model = settings.answerModel;
  const info = await getModelInfo(model);

  const input = {};
  if (info.systemField) {
    input.prompt = buildQuickTipPrompt(history);
    input[info.systemField] = buildSystemPrompt();
  } else {
    input.prompt = `${buildSystemPrompt()}\n\n---\n\n${buildQuickTipPrompt(history)}`;
  }
  setMaxTokens(input, info, 1024);

  await runStreamingPrediction(model, input, answerId);
}

// ---------------------------------------------------------------------------
// Follow-ups auf Antworten: Mehr / Code / Pro-Kontra / Beispiele
// ---------------------------------------------------------------------------

const FOLLOWUP_LABELS = {
  elaborate: "➕ Mehr dazu",
  code: "</> Code-Beispiel",
  proscons: "⚖ Pro & Kontra",
  examples: "🧩 Beispiele",
};

function followUpInstruction(mode) {
  switch (mode) {
    case "code":
      return [
        "Gib ein kleines, direkt nutzbares Code-Beispiel passend zur Frage.",
        "Ausgabe: maximal 1 kurze Kontextzeile, dann GENAU EIN Codeblock in der Form ```sprache (z. B. ```js, ```python) mit maximal ~20 Zeilen idiomatischem Code, danach maximal 1 kurze Hinweiszeile.",
      ].join("\n");
    case "proscons":
      return "Erstelle eine kompakte Pro/Kontra-Liste zur Frage: zuerst \"✅ Pro:\" mit 2-4 Stichpunkten, dann \"❌ Kontra:\" mit 2-4 Stichpunkten, je maximal 8 Woerter. Optional eine kurze Fazit-Zeile am Ende.";
    case "examples":
      return "Gib 2-3 konkrete Beispiele (je 1-2 Zeilen): reale Situationen, Zahlen oder Formulierungen, die man im Interview direkt sagen kann.";
    default: // elaborate
      return "Vertiefe die bisherige Kurzantwort NUR ETWAS: maximal 4 kurze Stichpunkte mit neuen Details (Zahlen, Begruendung, kurzes Beispiel). Wiederhole nichts bereits Gesagtes.";
  }
}

function buildFollowUpSystem() {
  return [
    "Du bist ein Echtzeit-Interview-Assistent. Die interviewte Person liest deine Ausgabe WAEHREND des Gespraechs — bleib kompakt und konkret.",
    `Profil der interviewten Person: ${settings.profile}`,
    "Keine Einleitung, keine Wiederholung der Frage, kein Meta-Kommentar.",
    answerLanguageRule(),
  ].join("\n");
}

function buildFollowUpPrompt(mode, question, answer, history) {
  return [
    `Juengster Gespraechsverlauf:\n${historyToText(history)}`,
    "",
    `Frage im Interview: ${question}`,
    `Bisherige Kurzantwort:\n${answer}`,
    "",
    followUpInstruction(mode),
  ].join("\n");
}

async function generateFollowUp(mode, question, answer, history, answerId) {
  const model = settings.answerModel;
  const info = await getModelInfo(model);

  const input = {};
  if (info.systemField) {
    input.prompt = buildFollowUpPrompt(mode, question, answer, history);
    input[info.systemField] = buildFollowUpSystem();
  } else {
    input.prompt = `${buildFollowUpSystem()}\n\n---\n\n${buildFollowUpPrompt(mode, question, answer, history)}`;
  }
  setMaxTokens(input, info, 1024);

  await runStreamingPrediction(model, input, answerId);
}

// ---------------------------------------------------------------------------
// Companion Mode: Verlauf pruefen und ggf. Notiz als Overlay einblenden
// ---------------------------------------------------------------------------

function buildCompanionPrompt(history, flow = {}) {
  return [
    `Juengster Gespraechsverlauf:\n${historyToText(history)}`,
    "",
    flow.topic
      ? `Aktuelles Interview-Thema (Overlay ist dazu eingeblendet): ${flow.topic}`
      : "Aktuelles Interview-Thema: noch keines erfasst.",
    flow.suggestions && flow.suggestions.length
      ? `Deine bisherigen Vorschlaege zum aktuellen Thema:\n${flow.suggestions.join("\n---\n")}`
      : "",
    "",
    "Aufgabe: Ordne die aktuelle Interview-Situation ein. Beginne deine Ausgabe mit GENAU EINER Steuerzeile:",
    "[THEMA: <Themenname, max 4 Woerter>] — eine NEUE Frage steht im Raum, bei der eine Notiz hilft. Danach: ❓-Zeile + 1-2 ultrakurze Stichpunkte.",
    "[VERTIEFUNG] — es wird explizit oder implizit weitergehend/genauer zum aktuellen Thema gefragt. Danach: eine Zeile \"↳ <was zusaetzlich gefragt wird, max 8 Woerter>\" + 1-2 Stichpunkte mit AUSSCHLIESSLICH der geforderten neuen Information (nichts wiederholen, nichts Ungefragtes).",
    "[ERLEDIGT] — die offene Frage wurde von der interviewten Person ausreichend beantwortet, die Einblendung kann weg. Danach nichts weiter.",
    "[KEINE_AKTION] — nichts Neues und nichts Hilfreiches (Smalltalk, Frage noch offen aber alles bereits vorgeschlagen). Danach nichts weiter.",
    "",
    "Wichtig — Stabilitaet hat Vorrang:",
    "- Ein Thema bleibt aktiv, bis es beantwortet ist. Im Zweifel IMMER [KEINE_AKTION].",
    "- Wenn der Interviewer seine Frage gerade noch formuliert oder praezisiert (unvollstaendiger Satz, \"also, ich meine ...\", Umformulierung mitten im Gedanken): [KEINE_AKTION] — warte auf die fertige Frage, statt eine womoeglich falsche Antwort zu liefern.",
    "- Wurde die Frage NACH deiner letzten Notiz praezisiert, sodass deine Notiz nicht mehr passt: [VERTIEFUNG] mit erster Zeile \"↳ Praezisiert: <neue Lesart>\" und der korrigierten Kurzantwort.",
    "- [VERTIEFUNG] NUR, wenn der Interviewer tatsaechlich eine neue Nachfrage oder Erweiterung gestellt hat — NIEMALS, um von dir aus weitere Ideen nachzuschieben, und niemals waehrend die interviewte Person gerade antwortet.",
    "- [THEMA: ...] NUR bei einem echten, kompletten Themenwechsel durch den Interviewer.",
    "- Der Themenname ist IMMER das inhaltliche Interview-Thema aus dem Gespraech (z. B. \"Kubernetes-Erfahrung\", \"Gehaltsvorstellung\", \"Konfliktverhalten\") — NIEMALS Meta-Begriffe wie \"Companion\", \"Check\", \"Analyse\" oder \"Notiz\".",
    "- Wenn das Thema dasselbe ist wie das aktuelle Interview-Thema oben: verwende NIE erneut [THEMA: ...] — sondern [VERTIEFUNG], [KEINE_AKTION] oder [ERLEDIGT].",
    "- Gib nie zweimal denselben Vorschlag aus.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function generateCompanionNote(history, flow) {
  const model = settings.answerModel;
  const info = await getModelInfo(model);

  const input = {};
  if (info.systemField) {
    input.prompt = buildCompanionPrompt(history, flow);
    input[info.systemField] = buildSystemPrompt();
  } else {
    input.prompt = `${buildSystemPrompt()}\n\n---\n\n${buildCompanionPrompt(history, flow)}`;
  }
  setMaxTokens(input, info, 1024);

  return runPrediction(model, input, null);
}

// Steuerzeile der Companion-Antwort auswerten
function parseCompanionResult(raw) {
  const t = (raw || "").trim();
  if (!t) return { action: "none" };
  const nl = t.indexOf("\n");
  const first = (nl === -1 ? t : t.slice(0, nl)).trim();
  const rest = nl === -1 ? "" : t.slice(nl + 1).trim();

  if (/KEINE_AKTION|NO_NOTE/i.test(first)) return { action: "none" };
  if (/ERLEDIGT/i.test(first)) return { action: "done" };
  if (/VERTIEFUNG/i.test(first)) return { action: "deep", text: rest || t };
  const mTopic = first.match(/THEMA:?\s*(.+?)\]?\s*$/i);
  if (mTopic && /THEMA/i.test(first)) {
    let topic = mTopic[1].replace(/[\[\]]/g, "").trim();
    // Meta-Begriffe sind keine Interview-Themen (Modell hat sich verlaufen)
    if (/companion|check|analyse|notiz|no.?note|keine/i.test(topic)) topic = null;
    return { action: "topic", topic, text: rest || t };
  }
  // keine Steuerzeile erkannt → als normale Notiz behandeln
  return { action: "topic", topic: null, text: t };
}

let companionWin = null;

function companionDisplay() {
  return (
    screen.getAllDisplays().find((d) => d.id === settings.companionDisplayId) ||
    screen.getPrimaryDisplay()
  );
}

// Kontext der letzten Companion-Einblendung — Basis fuer die Overlay-Buttons
let lastCompanionContext = null;

function showCompanionOverlay(payload) {
  const display = companionDisplay();
  const W = 440;
  const margin = 16;
  const x = display.workArea.x + display.workArea.width - W - margin;
  const y = display.workArea.y + margin;
  // maximale Hoehe: Fenster waechst mit dem Inhalt, scrollt aber nie
  payload.maxHeight = display.workArea.height - margin * 2;

  if (!companionWin || companionWin.isDestroyed()) {
    companionWin = new BrowserWindow({
      x,
      y,
      width: W,
      height: 140,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      focusable: false, // klaut Meeting-Fenstern nicht den Fokus
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "companion-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    companionWin.setAlwaysOnTop(true, "screen-saver");
    companionWin.loadFile(path.join(__dirname, "renderer", "companion.html"));
  }

  const cur = companionWin.getBounds();
  companionWin.setBounds({ x, y, width: W, height: cur.height });

  const deliver = () => {
    if (!companionWin || companionWin.isDestroyed()) return;
    companionWin.webContents.send("companion-note", payload);
    companionWin.showInactive();
  };
  if (companionWin.webContents.isLoading()) {
    companionWin.webContents.once("did-finish-load", deliver);
  } else {
    deliver();
  }
}

function hideCompanionOverlay() {
  if (companionWin && !companionWin.isDestroyed()) companionWin.hide();
}

ipcMain.on("companion-hide", hideCompanionOverlay);

// Das Overlay meldet seine Inhalts-Hoehe → Fenster waechst mit (kein Scrollen)
ipcMain.on("companion-resize", (_e, { height }) => {
  if (!companionWin || companionWin.isDestroyed()) return;
  const display = companionDisplay();
  const maxH = display.workArea.height - 32;
  const h = Math.max(90, Math.min(Math.round(height), maxH));
  const b = companionWin.getBounds();
  companionWin.setResizable(true);
  companionWin.setBounds({ x: b.x, y: b.y, width: b.width, height: h });
  companionWin.setResizable(false);
});

// Follow-up-Buttons AUF dem Overlay: neuer Block im Overlay + Karte im Panel
ipcMain.on("companion-followup", (_e, { mode }) => {
  const ctx = lastCompanionContext;
  if (!ctx || !apiKey()) return;
  const tag = FOLLOWUP_LABELS[mode] || "➕ Mehr dazu";
  const label = `${tag} — ${ctx.question.slice(0, 60)}`;
  runAnswerTask(
    label,
    async (id) => {
      const text = await generateFollowUp(mode, ctx.question, ctx.answer, ctx.history, id);
      if (text && text.trim()) {
        showCompanionOverlay({ mode: "append", tag, text: text.trim() });
        ctx.answer += `\n\n${text.trim()}`; // Kontext fortschreiben
      }
    },
    "followup"
  );
});

// Themenwechsel, der auf Bestaetigung durch den User wartet
let pendingTopic = null;

function applyCompanionTopic(topic, text, history) {
  lastCompanionContext = {
    question: topic || (text.split("\n")[0] || "").replace(/^❓\s*/, ""),
    answer: text,
    history,
  };
  showCompanionOverlay({ mode: "reset", topic, text });
}

ipcMain.on("companion-topic-confirm", (_e, { accept }) => {
  const p = pendingTopic;
  pendingTopic = null;
  if (!p) return;
  if (accept) {
    applyCompanionTopic(p.topic, p.text, p.history);
    sendToRenderer("companion-topic-accepted", { topic: p.topic, text: p.text });
  }
  // abgelehnt → aktueller Gespraechsfaden bleibt unveraendert stehen
});

ipcMain.handle("companion-check", async (_e, { history, flow }) => {
  if (!apiKey() || !history || !history.length) return { action: "none" };
  try {
    const raw = await generateCompanionNote(history, flow || {});
    const res = parseCompanionResult(raw);

    if (res.action === "done") {
      hideCompanionOverlay();
      lastCompanionContext = null;
    } else if (res.action === "topic") {
      const sameTopic =
        res.topic &&
        flow?.topic &&
        res.topic.toLowerCase() === String(flow.topic).toLowerCase();

      if (sameTopic) {
        // gleiches Thema → im Faden anhaengen statt ersetzen
        if (lastCompanionContext) lastCompanionContext.answer += `\n\n${res.text}`;
        showCompanionOverlay({ mode: "append", text: res.text });
        return { ...res, action: "deep" };
      }

      // Kompletter Themenwechsel bei laufendem Faden → ggf. erst bestaetigen
      if (settings.topicConfirm && flow?.topic && res.topic) {
        pendingTopic = { topic: res.topic, text: res.text, history };
        showCompanionOverlay({ mode: "confirm", topic: res.topic });
        return { action: "pending", topic: res.topic };
      }

      applyCompanionTopic(res.topic, res.text, history);
    } else if (res.action === "deep") {
      if (lastCompanionContext) lastCompanionContext.answer += `\n\n${res.text}`;
      else lastCompanionContext = { question: flow?.topic || "Vertiefung", answer: res.text, history };
      showCompanionOverlay({ mode: "append", tag: "↳ Vertiefung", text: res.text });
    }
    return res;
  } catch (err) {
    return { action: "none", error: err.message };
  }
});

ipcMain.handle("list-displays", () => {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label:
      `${d.label || `Display ${i + 1}`} — ${d.bounds.width}x${d.bounds.height}` +
      (d.id === primaryId ? " (Haupt)" : ""),
  }));
});

// ---------------------------------------------------------------------------
// Screenshot-Analyse (Vision-Modell)
// ---------------------------------------------------------------------------

async function captureRegionImage() {
  const r = settings.captureRegion;
  if (!r) throw new Error("Kein Bildschirmbereich festgelegt");

  const display =
    screen.getAllDisplays().find((d) => d.id === r.displayId) ||
    screen.getPrimaryDisplay();

  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.round(display.bounds.width * display.scaleFactor),
      height: Math.round(display.bounds.height * display.scaleFactor),
    },
  });
  const src =
    sources.find((s) => s.display_id === String(display.id)) || sources[0];
  if (!src) throw new Error("Bildschirmquelle nicht gefunden");

  const size = src.thumbnail.getSize();
  const sx = size.width / display.bounds.width;
  const sy = size.height / display.bounds.height;

  const img = src.thumbnail.crop({
    x: Math.max(0, Math.round(r.x * sx)),
    y: Math.max(0, Math.round(r.y * sy)),
    width: Math.min(size.width, Math.round(r.width * sx)),
    height: Math.min(size.height, Math.round(r.height * sy)),
  });
  return img.toPNG();
}

async function analyzeScreen(history, answerId) {
  const model = settings.visionModel;
  const info = await getModelInfo(model);
  if (!info.imageField) {
    throw new Error(
      `Modell "${model}" akzeptiert laut Schema keine Bilder. Bitte in den Einstellungen ein Vision-Modell waehlen.`
    );
  }

  const png = await captureRegionImage();
  const imageUrl = await bufferToUrl(png, "image/png", "screen.png");

  const input = { prompt: buildVisionUserPrompt(history) };
  input[info.imageField] = info.imageIsArray ? [imageUrl] : imageUrl;
  const visionSystem = buildVisionSystemPrompt();
  if (info.systemField) input[info.systemField] = visionSystem;
  else input.prompt = `${visionSystem}\n\n---\n\n${input.prompt}`;
  setMaxTokens(input, info, 1024);

  await runStreamingPrediction(model, input, answerId);
}

// ---------------------------------------------------------------------------
// Bereichsauswahl (transparentes Overlay-Fenster)
// ---------------------------------------------------------------------------

function selectRegion() {
  return new Promise((resolve) => {
    if (overlayWin) {
      overlayWin.focus();
      resolve(null);
      return;
    }

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

    overlayWin = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, "overlay-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    overlayWin.setAlwaysOnTop(true, "screen-saver");
    overlayWin.loadFile(path.join(__dirname, "renderer", "overlay.html"));

    let resolved = false;
    const finish = (_e, rect) => {
      if (resolved) return;
      resolved = true;
      ipcMain.removeListener("region-selected", finish);
      if (overlayWin) {
        overlayWin.close();
        overlayWin = null;
      }
      if (rect && rect.width >= 20 && rect.height >= 20) {
        settings.captureRegion = {
          displayId: display.id,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        };
        persistSettings(settings);
        resolve(settings.captureRegion);
      } else {
        resolve(null);
      }
    };
    ipcMain.on("region-selected", finish);

    // Overlay anderweitig geschlossen → Listener aufraeumen, sauber aufloesen
    overlayWin.on("closed", () => {
      overlayWin = null;
      finish(null, null);
    });
  });
}

// ---------------------------------------------------------------------------
// Modell-Listen fuer die Auswahl in den Einstellungen
// ---------------------------------------------------------------------------

const FALLBACK_STT_MODELS = [
  "openai/gpt-4o-mini-transcribe",
  "openai/gpt-4o-transcribe",
  "openai/whisper",
  "vaibhavs10/incredibly-fast-whisper",
  "victor-upmeet/whisperx",
  "nvidia/parakeet-rnnt-1.1b",
];

const FALLBACK_LLM_MODELS = [
  "anthropic/claude-4.5-haiku",
  "anthropic/claude-4.5-sonnet",
  "anthropic/claude-opus-4.6",
  "openai/gpt-5-mini",
  "openai/gpt-4o-mini",
  "google/gemini-2.5-flash",
  "deepseek-ai/deepseek-v3.1",
  "meta/meta-llama-3-70b-instruct",
];

const FALLBACK_VISION_MODELS = [
  "google/gemini-3-flash",
  "anthropic/claude-4.5-sonnet",
  "openai/gpt-5.4",
  "openai/gpt-5",
  "openai/gpt-4o-mini",
  "lucataco/moondream2",
];

async function fetchCollectionModels(slug) {
  const data = await repJson(`${REPLICATE_BASE}/collections/${slug}`);
  return (data.models || []).map((m) => `${m.owner}/${m.name}`);
}

// ---------------------------------------------------------------------------
// Fenster + IPC
// ---------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    alwaysOnTop: settings.alwaysOnTop,
    title: "Interview Helper",
    icon: path.join(__dirname, "assets", "icon.ico"),
    backgroundColor: "#111318",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // System-Audio-Loopback fuer getDisplayMedia (Windows)
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen"] })
        .then((sources) => {
          callback({ video: sources[0], audio: "loopback" });
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: false }
  );

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  settings = loadSettings();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// --- Settings ---
ipcMain.handle("get-settings", () => ({
  ...settings,
  hasEnvKey: !!process.env.REPLICATE_API_TOKEN,
}));

ipcMain.handle("save-settings", (_e, newSettings) => {
  settings = sanitizeModels({ ...settings, ...newSettings });
  const seg = parseFloat(settings.maxSegmentSec);
  settings.maxSegmentSec = isFinite(seg) ? Math.min(30, Math.max(0.5, seg)) : 1;
  const iv = parseFloat(settings.companionIntervalSec);
  settings.companionIntervalSec = isFinite(iv) ? Math.min(300, Math.max(5, iv)) : 20;
  persistSettings(settings);
  if (win) win.setAlwaysOnTop(!!settings.alwaysOnTop);
  modelInfoCache.clear(); // bei Modellwechsel Schemas neu laden
  return settings;
});

ipcMain.handle("set-always-on-top", (_e, flag) => {
  settings.alwaysOnTop = !!flag;
  persistSettings(settings);
  if (win) win.setAlwaysOnTop(settings.alwaysOnTop);
  return settings.alwaysOnTop;
});

// --- Modell-Listen ---
ipcMain.handle("list-models", async () => {
  const fallback = {
    stt: FALLBACK_STT_MODELS,
    llm: FALLBACK_LLM_MODELS,
    vision: FALLBACK_VISION_MODELS,
    live: false,
  };
  if (!apiKey()) return fallback;
  try {
    const [stt, llm, vision] = await Promise.all([
      fetchCollectionModels("speech-to-text"),
      fetchCollectionModels("language-models"),
      fetchCollectionModels("vision-models"),
    ]);
    return {
      stt: stt.length ? stt : FALLBACK_STT_MODELS,
      llm: llm.length ? llm : FALLBACK_LLM_MODELS,
      vision: vision.length ? vision : FALLBACK_VISION_MODELS,
      live: true,
    };
  } catch {
    return fallback;
  }
});

// --- Bereichsauswahl ---
ipcMain.handle("select-region", () => selectRegion());

// ---------------------------------------------------------------------------
// Gespeicherte Gespraeche (conversations.json im userData-Verzeichnis)
// ---------------------------------------------------------------------------

function conversationsPath() {
  return path.join(app.getPath("userData"), "conversations.json");
}

function loadConversations() {
  try {
    const arr = JSON.parse(fs.readFileSync(conversationsPath(), "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function persistConversations(arr) {
  fs.writeFileSync(conversationsPath(), JSON.stringify(arr, null, 2), "utf8");
}

function conversationMetas(arr) {
  return arr.map(({ id, title, createdAt, updatedAt }) => ({
    id,
    title,
    createdAt,
    updatedAt,
  }));
}

ipcMain.handle("conv-list", () => conversationMetas(loadConversations()));

ipcMain.handle("conv-get", (_e, id) =>
  loadConversations().find((c) => c.id === id) || null
);

ipcMain.handle("conv-save", (_e, { id, title, transcript, answers }) => {
  const arr = loadConversations();
  const now = new Date().toISOString();
  let conv = id ? arr.find((c) => c.id === id) : null;
  if (conv) {
    conv.title = title || conv.title;
    conv.transcript = transcript;
    conv.answers = answers;
    conv.updatedAt = now;
  } else {
    conv = {
      id: require("crypto").randomUUID(),
      title: title || `Gespraech vom ${new Date().toLocaleString("de-DE")}`,
      createdAt: now,
      updatedAt: now,
      transcript,
      answers,
    };
    arr.push(conv);
  }
  persistConversations(arr);
  return { id: conv.id, metas: conversationMetas(arr) };
});

ipcMain.handle("conv-delete", (_e, id) => {
  const arr = loadConversations().filter((c) => c.id !== id);
  persistConversations(arr);
  return conversationMetas(arr);
});

// --- Transkription ---
ipcMain.on("transcribe-utterance", (_e, { channel, itemId, pcm }) => {
  if (!apiKey()) {
    sendToRenderer("stt-status", {
      channel,
      status: "error",
      message: "Kein Replicate API-Key hinterlegt (Einstellungen).",
    });
    sendToRenderer("transcript", { channel, itemId, text: "", final: true });
    return;
  }
  transcribeUtterance(channel, itemId, pcm);
});

// --- Antworten + Screenshot-Analyse ---
let answerCounter = 0;

function runAnswerTask(label, fn, kind = "generic") {
  const answerId = ++answerCounter;
  sendToRenderer("answer-start", { id: answerId, question: label, kind });

  (async () => {
    try {
      if (!apiKey()) {
        sendToRenderer("answer-delta", {
          id: answerId,
          text: "[Kein Replicate API-Key hinterlegt]",
        });
      } else {
        await fn(answerId);
        return;
      }
    } catch (err) {
      const msg = /404/.test(err.message)
        ? `[Modell wurde auf Replicate nicht gefunden (404). Bitte in den Einstellungen ein gueltiges Modell waehlen.]`
        : `[Fehler: ${err.message}]`;
      sendToRenderer("answer-delta", { id: answerId, text: msg });
    }
    sendToRenderer("answer-done", { id: answerId });
  })();

  return { id: answerId };
}

ipcMain.handle("generate-answer", (_e, { question, history, flow }) =>
  runAnswerTask(
    question,
    (id) => generateAnswer(question, history, flow || {}, id),
    "answer"
  )
);

ipcMain.handle("analyze-screen", (_e, { history }) =>
  runAnswerTask("📸 Screenshot-Analyse", (id) => analyzeScreen(history, id))
);

ipcMain.handle("quick-tip", (_e, { history }) =>
  runAnswerTask("💡 Schnell-Tipp", (id) => generateQuickTip(history, id))
);

ipcMain.handle("follow-up", (_e, { mode, question, answer, history }) => {
  const cleanQ = String(question || "").replace(/^❓\s*/, "").slice(0, 60);
  const label = `${FOLLOWUP_LABELS[mode] || "➕ Mehr dazu"} — ${cleanQ}`;
  return runAnswerTask(label, (id) =>
    generateFollowUp(mode, question, answer, history, id)
  );
});

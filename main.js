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
// Settings (JSON file in the userData directory)
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  replicateApiKey: "",
  sttModel: "openai/gpt-4o-mini-transcribe",
  answerModel: "anthropic/claude-4.5-haiku",
  visionModel: "google/gemini-3-flash",
  language: "en",
  maxSegmentSec: 1, // split long speech into segments every N seconds
  autoAnswer: true,
  companionMode: false,
  companionIntervalSec: 20,
  companionDisplayId: null, // display for the companion overlay
  topicConfirm: false, // companion topic changes require user confirmation
  alwaysOnTop: true,
  legalAccepted: false,
  captureRegion: null, // { displayId, x, y, width, height } (DIP, relative to display)
  profile:
    "Candidate for a software developer position. Experienced with JavaScript, TypeScript and web development.",
};

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

// Replicate models are always named "owner/name" — anything else (e.g.
// leftovers from an older app version) is reset to the defaults.
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
// Cost tracking (estimate for the running session)
// ---------------------------------------------------------------------------

// Rough price list (USD). Token models: [input, output] per million tokens;
// audio models: per audio minute. Models not listed here are counted as
// "no pricing data".
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
  // Community STT: GPU compute time, USD per second of predict_time
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
  // real token counts from the prediction metrics, else ~4 chars/token
  const tIn = metrics?.input_token_count ?? Math.ceil(promptChars / 4);
  const tOut = metrics?.output_token_count ?? Math.ceil(outputChars / 4);
  addUsage((tIn * p[0] + tOut * p[1]) / 1e6);
}

// ---------------------------------------------------------------------------
// Replicate HTTP helpers
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

// Load and cache each model's schema once so arbitrary user-selected models
// work (field names for audio/image/system prompt vary between models).
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
    versionId: null, // for community models (version-based predictions)
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

    // audio input field (URI field whose name sounds like audio)
    const audioField = uriFields.find((n) => /audio|voice|speech|file/i.test(n));
    if (audioField) info.audioField = audioField;

    // image input field: single URI or URI array
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
    // keep the fallback heuristics
  }
  modelInfoCache.set(model, info);
  return info;
}

// Convert prediction output to text (models return a string, an array of
// strings, or objects with a text/transcription field)
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

// Auto-fix 422 validation errors like "input.max_tokens: Must be greater
// than or equal to 1024" by parsing the limit out of the error message
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

// Create a prediction: official models run via
// /models/{owner}/{name}/predictions, community models only via
// /predictions with a version ID. On 404 switch automatically (cached).
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
      info.useVersionEndpoint = true; // use the version endpoint from now on
    }
  }

  if (!info.versionId) {
    throw new Error(`Replicate HTTP 404: model ${model} has no version`);
  }
  return repJson(`${REPLICATE_BASE}/predictions`, {
    method: "POST",
    headers: allHeaders,
    body: JSON.stringify({ ...body, version: info.versionId }),
  });
}

// Adapt the language parameter to the model: some expect ISO codes ("de"),
// others expect language names from an enum ("german")
const LANGUAGE_NAMES = {
  de: "german",
  en: "english",
  hi: "hindi",
  zh: "chinese",
  ja: "japanese",
  es: "spanish",
  fr: "french",
};

// Display names used inside the prompts ("Respond in ...")
const LANGUAGE_LABELS = {
  de: "German",
  en: "English",
  hi: "Hindi",
  zh: "Chinese",
  ja: "Japanese",
  es: "Spanish",
  fr: "French",
};

function answerLanguageRule() {
  const label = LANGUAGE_LABELS[settings.language];
  return label
    ? `- Respond in ${label}.`
    : "- Respond in the same language as the question.";
}

function resolveLanguage(info, code) {
  if (!info.languageEnum) return code;
  if (info.languageEnum.includes(code)) return code;
  const name = LANGUAGE_NAMES[code];
  if (name && info.languageEnum.includes(name)) return name;
  return null; // no matching value — omit the parameter (auto-detect)
}

async function waitForPrediction(pred, timeoutMs = 90000) {
  const start = Date.now();
  let current = pred;
  while (current.status === "starting" || current.status === "processing") {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Replicate prediction timeout");
    }
    await new Promise((r) => setTimeout(r, 600));
    current = await repJson(current.urls.get);
  }
  if (current.status !== "succeeded") {
    throw new Error(current.error || `Prediction ${current.status}`);
  }
  return current;
}

// Small files as data URIs, larger ones via the Replicate Files API
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
// Transcription: build WAV, upload, run prediction
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

    // Cost: per audio minute (official models) or per second of compute
    // time (community models on GPU hardware)
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
      ? `Model "${settings.sttModel}" was not found on Replicate (404). Please pick a valid transcription model in the settings.`
      : err.message;
    sendToRenderer("stt-status", { channel, status: "error", message: msg });
  }
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function buildSystemPrompt() {
  return [
    "You are a real-time interview assistant. The interviewee reads your answer WHILE they are speaking — they only have 2-3 seconds to grasp it.",
    "",
    `Interviewee profile: ${settings.profile}`,
    "",
    'Important — imperfect transcription: speech recognition often mangles technical terms (e.g. "Angela directives" instead of "Angular directives", "Cuba netes" instead of "Kubernetes"). Always reconstruct the INTENDED terms from the conversation context and the interviewee profile.',
    "",
    "Output format (strict, no deviation):",
    'Line 1: "❓ " + the question as you understood it, cleanly rephrased with the reconstructed technical terms, at most 10 words.',
    'Then the answer: 1-2 bullet points starting with "- ", at most 8 words per point.',
    "One point is usually enough — two only if needed.",
    'EXCEPTION: if the question clearly demands a longer answer ("explain in detail", a comparison, a multi-part question), up to 4 bullet points — but still only the minimum required for a correct answer.',
    "",
    "Rules:",
    "- Provide ONLY the information that was asked for — no unrequested additions, no extra tips, no extra context.",
    "- Key terms instead of sentences. Concrete numbers, technical terms, names.",
    "- No filler words, no introduction, no explanation, no meta commentary.",
    '- For yes/no questions the first point starts with "Yes:" or "No:".',
    answerLanguageRule(),
    "",
    "Example:",
    "❓ Why should we hire you?",
    "- 5 years TypeScript, 3 production apps",
    "- Strength: fast onboarding into unfamiliar code",
  ].join("\n");
}

function historyToText(history) {
  return history && history.length
    ? history.map((h) => `${h.speaker}: ${h.text}`).join("\n")
    : "(no conversation history yet)";
}

function buildUserPrompt(question, history, flow = {}) {
  const parts = [];
  if (history && history.length) {
    parts.push(`Conversation so far (truncated):\n${historyToText(history)}`);
  }
  parts.push(
    flow.topic
      ? `Current interview topic: ${flow.topic}`
      : "Current interview topic: none recorded yet."
  );
  if (flow.suggestions && flow.suggestions.length) {
    parts.push(
      `Your previous answer suggestions for the current topic:\n${flow.suggestions.join("\n---\n")}`
    );
  }
  parts.push(
    `Latest interviewer statement (transcription, possibly imperfect): "${question}"`
  );
  parts.push(
    [
      "Interview flow: question → interviewee answers → then either a deeper follow-up on the same topic OR a switch to the next question.",
      "Classify the current statement and start your output with EXACTLY ONE control line:",
      '[TOPIC: <topic name, max 4 words>] — a new question / new topic begins. This ALSO applies when the statement is not a grammatical question: a technical term thrown into the room ("So, Angular directives."), a request ("Tell me about ..."), or a recognizable transition to the first/next interview question all count as a new topic.',
      "[FOLLOW_UP] — a deeper follow-up question on the current topic.",
      "[NO_ACTION] — no new suggestion needed: the question is already covered by your previous suggestions, or it is not a real new question (acknowledgement, continued talking, small talk).",
      "",
      "After [NO_ACTION]: end your output immediately, write nothing else.",
      "After [TOPIC: ...]: new line, then the ❓ line + 1-2 ultra-short bullet points.",
      "After [FOLLOW_UP]: new line, then the ❓ line (the follow-up question) + 1-3 bullet points containing ONLY new additional information that complements your previous suggestions — repeat nothing.",
    ].join("\n")
  );
  return parts.join("\n\n");
}

function buildVisionSystemPrompt() {
  return [
    "You are a real-time interview assistant with a view of the interviewee's screen. They read your output DURING the conversation — they only have a few seconds.",
    "You receive a screenshot of a selected screen region plus the most recent conversation history. Decide yourself what helps most RIGHT NOW.",
    "",
    "Output format (strict):",
    '- At most 5 bullet points starting with "- ", at most 8 words each.',
    "- Only concrete facts from the screenshot + conversation: numbers, requirements, error messages, names.",
    "- The most important point ALWAYS comes first.",
    "- No introduction, no image description, no meta commentary, no filler words.",
    "- Optionally EXACTLY ONE small Mermaid diagram in a ```mermaid code block (flowchart TD or LR, at most 8 nodes, labels at most 3 words) — only if a flow/structure is faster to grasp visually.",
    answerLanguageRule(),
  ].join("\n");
}

function buildVisionUserPrompt(history) {
  return [
    `Most recent conversation history:\n${historyToText(history)}`,
    "",
    "Analyze the attached screenshot in the context of this conversation and show me the most helpful information.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// LLM calls (SSE streaming with polling fallback)
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
          // SSE: strip exactly one leading space after "data:"
          let d = line.slice(5);
          if (d.startsWith(" ")) d = d.slice(1);
          dataLines.push(d);
        }
      }
      const data = dataLines.join("\n");

      if (eventType === "output") onDelta(data);
      else if (eventType === "error") throw new Error(data || "stream error");
      else if (eventType === "done") return;
    }
  }
}

// Set the desired token limit, clamped to the model's schema bounds
// (some models require a minimum of e.g. 1024)
function setMaxTokens(input, info, desired) {
  if (!info.maxTokensField) return;
  let v = desired;
  if (info.maxTokensMin != null) v = Math.max(v, info.maxTokensMin);
  if (info.maxTokensMax != null) v = Math.min(v, info.maxTokensMax);
  input[info.maxTokensField] = v;
}

// Sum of all string fields of an input (for the token estimate),
// excluding data URIs (images/audio)
function promptCharsOf(input) {
  let chars = 0;
  for (const v of Object.values(input)) {
    if (typeof v === "string" && !v.startsWith("data:") && !v.startsWith("http")) {
      chars += v.length;
    }
  }
  return chars;
}

// Run a prediction, deliver deltas to onDelta, return the full text
async function runPrediction(model, input, onDelta) {
  const pred = await createPrediction(model, { input, stream: true });

  let full = "";
  let metrics = null;

  if (pred.urls && pred.urls.stream) {
    await streamSse(pred.urls.stream, (delta) => {
      full += delta;
      if (onDelta) onDelta(delta);
    });
    // fetch metrics (real token counts) after the stream ends
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
  // An upper bound, not a target — the prompt enforces brevity. 1024 also
  // satisfies the minimum some models enforce server-side.
  setMaxTokens(input, info, 1024);

  await runStreamingPrediction(model, input, answerId);
}

// Quick tip: only the conversation history, no explicit question target.
// The model decides on its own what helps most right now.
function buildQuickTipPrompt(history) {
  return [
    `Most recent conversation history:\n${historyToText(history)}`,
    "",
    "No explicit trigger — the interviewee manually asked for help.",
    "Decide yourself what helps most RIGHT NOW, exactly one of:",
    "a) an answer suggestion for the interviewer's most recent open question/statement,",
    "b) a tactical tip (e.g. ask a clarifying question, give an example, go deeper on a point),",
    "c) the one detail/argument still missing in this situation.",
    "",
    "Respond in the given format: ❓ line (what you are referring to), then 1-2 ultra-short bullet points.",
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
// Follow-ups on answers: more / code / pros-cons / examples
// ---------------------------------------------------------------------------

const FOLLOWUP_LABELS = {
  elaborate: "➕ More",
  code: "</> Code example",
  proscons: "⚖ Pros & cons",
  examples: "🧩 Examples",
};

function followUpInstruction(mode) {
  switch (mode) {
    case "code":
      return [
        "Provide a small, directly usable code example matching the question.",
        "Output: at most 1 short context line, then EXACTLY ONE code block in the form ```language (e.g. ```js, ```python) with at most ~20 lines of idiomatic code, then at most 1 short note line.",
      ].join("\n");
    case "proscons":
      return 'Create a compact pros/cons list for the question: first "✅ Pros:" with 2-4 bullet points, then "❌ Cons:" with 2-4 bullet points, at most 8 words each. Optionally one short conclusion line at the end.';
    case "examples":
      return "Give 2-3 concrete examples (1-2 lines each): real situations, numbers, or phrasings that can be said directly in the interview.";
    default: // elaborate
      return "Expand the previous short answer ONLY SLIGHTLY: at most 4 short bullet points with new details (numbers, reasoning, a short example). Repeat nothing already said.";
  }
}

function buildFollowUpSystem() {
  return [
    "You are a real-time interview assistant. The interviewee reads your output DURING the conversation — stay compact and concrete.",
    `Interviewee profile: ${settings.profile}`,
    "No introduction, no repetition of the question, no meta commentary.",
    answerLanguageRule(),
  ].join("\n");
}

function buildFollowUpPrompt(mode, question, answer, history) {
  return [
    `Most recent conversation history:\n${historyToText(history)}`,
    "",
    `Interview question: ${question}`,
    `Previous short answer:\n${answer}`,
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

  return runStreamingPrediction(model, input, answerId);
}

// ---------------------------------------------------------------------------
// Companion mode: check the conversation and show notes as an overlay
// ---------------------------------------------------------------------------

function buildCompanionPrompt(history, flow = {}) {
  return [
    `Most recent conversation history:\n${historyToText(history)}`,
    "",
    flow.topic
      ? `Current interview topic (the overlay currently shows it): ${flow.topic}`
      : "Current interview topic: none recorded yet.",
    flow.suggestions && flow.suggestions.length
      ? `Your previous suggestions for the current topic:\n${flow.suggestions.join("\n---\n")}`
      : "",
    "",
    "Task: classify the current interview situation. Start your output with EXACTLY ONE control line:",
    "[TOPIC: <topic name, max 4 words>] — a NEW question is on the table where a note helps. Then: ❓ line + 1-2 ultra-short bullet points.",
    '[FOLLOW_UP] — the interviewer explicitly or implicitly asks deeper/more precisely about the current topic. Then: one line "↳ <what is additionally asked, max 8 words>" + 1-2 bullet points with ONLY the requested new information (repeat nothing, add nothing unrequested).',
    "[RESOLVED] — the open question has been answered sufficiently by the interviewee; the overlay can go away. Then nothing else.",
    "[NO_ACTION] — nothing new and nothing helpful (small talk, question still open but everything already suggested). Then nothing else.",
    "",
    "Important — stability comes first:",
    "- A topic stays active until it is answered. When in doubt, ALWAYS [NO_ACTION].",
    '- If the interviewer is still formulating or refining their question (incomplete sentence, "well, what I mean is ...", rephrasing mid-thought): [NO_ACTION] — wait for the finished question instead of delivering a possibly wrong answer.',
    '- If the question was refined AFTER your last note so that your note no longer fits: [FOLLOW_UP] with the first line "↳ Clarified: <new reading>" and the corrected short answer.',
    "- [FOLLOW_UP] ONLY when the interviewer actually asked a new follow-up or extension — NEVER to push additional ideas on your own, and never while the interviewee is currently answering.",
    "- [TOPIC: ...] ONLY on a real, complete topic change by the interviewer.",
    '- The topic name is ALWAYS the actual interview topic from the conversation (e.g. "Kubernetes experience", "salary expectations", "conflict handling") — NEVER meta terms like "companion", "check", "analysis" or "note".',
    "- If the topic is the same as the current interview topic above: NEVER use [TOPIC: ...] again — use [FOLLOW_UP], [NO_ACTION] or [RESOLVED] instead.",
    "- Never output the same suggestion twice.",
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

// Parse the control line of the companion response
function parseCompanionResult(raw) {
  const t = (raw || "").trim();
  if (!t) return { action: "none" };
  const nl = t.indexOf("\n");
  const first = (nl === -1 ? t : t.slice(0, nl)).trim();
  const rest = nl === -1 ? "" : t.slice(nl + 1).trim();

  if (/NO_ACTION|NO_NOTE/i.test(first)) return { action: "none" };
  if (/RESOLVED/i.test(first)) return { action: "done" };
  if (/FOLLOW_UP/i.test(first)) return { action: "deep", text: rest || t };
  const mTopic = first.match(/TOPIC:?\s*(.+?)\]?\s*$/i);
  if (mTopic && /TOPIC/i.test(first)) {
    let topic = mTopic[1].replace(/[\[\]]/g, "").trim();
    // meta terms are not interview topics (the model got lost)
    if (/companion|check|analysis|note|no.?note|action/i.test(topic)) topic = null;
    return { action: "topic", topic, text: rest || t };
  }
  // no control line recognized → treat as a regular note
  return { action: "topic", topic: null, text: t };
}

let companionWin = null;

function companionDisplay() {
  return (
    screen.getAllDisplays().find((d) => d.id === settings.companionDisplayId) ||
    screen.getPrimaryDisplay()
  );
}

// Context of the latest companion note — basis for the overlay buttons
let lastCompanionContext = null;

function showCompanionOverlay(payload) {
  const display = companionDisplay();
  const W = 440;
  const margin = 16;
  const x = display.workArea.x + display.workArea.width - W - margin;
  const y = display.workArea.y + margin;
  // max height: the window grows with its content but never scrolls
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
      focusable: false, // never steals focus from meeting windows
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

// The overlay reports its content height → the window grows (no scrolling)
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

// Follow-up buttons ON the overlay: new block in the overlay + card in panel
ipcMain.on("companion-followup", (_e, { mode }) => {
  const ctx = lastCompanionContext;
  if (!ctx || !apiKey()) return;
  const tag = FOLLOWUP_LABELS[mode] || "➕ More";
  const label = `${tag} — ${ctx.question.slice(0, 60)}`;
  runAnswerTask(
    label,
    async (id) => {
      const text = await generateFollowUp(mode, ctx.question, ctx.answer, ctx.history, id);
      if (text && text.trim()) {
        showCompanionOverlay({ mode: "append", tag, text: text.trim() });
        ctx.answer += `\n\n${text.trim()}`; // extend the running context
      }
    },
    "followup"
  );
});

// Topic change waiting for user confirmation
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
  // declined → the current conversation thread stays untouched
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
        // same topic → append to the thread instead of replacing it
        if (lastCompanionContext) lastCompanionContext.answer += `\n\n${res.text}`;
        showCompanionOverlay({ mode: "append", text: res.text });
        return { ...res, action: "deep" };
      }

      // complete topic change while a thread is active → confirm first
      if (settings.topicConfirm && flow?.topic && res.topic) {
        pendingTopic = { topic: res.topic, text: res.text, history };
        showCompanionOverlay({ mode: "confirm", topic: res.topic });
        return { action: "pending", topic: res.topic };
      }

      applyCompanionTopic(res.topic, res.text, history);
    } else if (res.action === "deep") {
      if (lastCompanionContext) lastCompanionContext.answer += `\n\n${res.text}`;
      else lastCompanionContext = { question: flow?.topic || "Follow-up", answer: res.text, history };
      showCompanionOverlay({ mode: "append", tag: "↳ Follow-up", text: res.text });
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
      (d.id === primaryId ? " (primary)" : ""),
  }));
});

// ---------------------------------------------------------------------------
// Screen analysis (vision model)
// ---------------------------------------------------------------------------

async function captureRegionImage() {
  const r = settings.captureRegion;
  if (!r) throw new Error("No screen region defined");

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
  if (!src) throw new Error("Screen source not found");

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
      `Model "${model}" does not accept images according to its schema. Please pick a vision model in the settings.`
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
// Region selection (transparent overlay window)
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

    // overlay closed some other way → clean up the listener, resolve cleanly
    overlayWin.on("closed", () => {
      overlayWin = null;
      finish(null, null);
    });
  });
}

// ---------------------------------------------------------------------------
// Model lists for the settings dropdowns
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
// Window + IPC
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

  // system audio loopback for getDisplayMedia (Windows)
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
  modelInfoCache.clear(); // reload schemas after a model change
  return settings;
});

ipcMain.handle("set-always-on-top", (_e, flag) => {
  settings.alwaysOnTop = !!flag;
  persistSettings(settings);
  if (win) win.setAlwaysOnTop(settings.alwaysOnTop);
  return settings.alwaysOnTop;
});

// --- Model lists ---
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

// --- Region selection ---
ipcMain.handle("select-region", () => selectRegion());

// ---------------------------------------------------------------------------
// Saved conversations (conversations.json in the userData directory)
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
      title: title || `Conversation from ${new Date().toLocaleString("en-GB")}`,
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

// --- Transcription ---
ipcMain.on("transcribe-utterance", (_e, { channel, itemId, pcm }) => {
  if (!apiKey()) {
    sendToRenderer("stt-status", {
      channel,
      status: "error",
      message: "No Replicate API key configured (settings).",
    });
    sendToRenderer("transcript", { channel, itemId, text: "", final: true });
    return;
  }
  transcribeUtterance(channel, itemId, pcm);
});

// --- Answers + screen analysis ---
let answerCounter = 0;

function runAnswerTask(label, fn, kind = "generic") {
  const answerId = ++answerCounter;
  sendToRenderer("answer-start", { id: answerId, question: label, kind });

  (async () => {
    try {
      if (!apiKey()) {
        sendToRenderer("answer-delta", {
          id: answerId,
          text: "[No Replicate API key configured]",
        });
      } else {
        await fn(answerId);
        return;
      }
    } catch (err) {
      const msg = /404/.test(err.message)
        ? `[Model was not found on Replicate (404). Please pick a valid model in the settings.]`
        : `[Error: ${err.message}]`;
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
  runAnswerTask("📸 Screen analysis", (id) => analyzeScreen(history, id))
);

ipcMain.handle("quick-tip", (_e, { history }) =>
  runAnswerTask("💡 Quick tip", (id) => generateQuickTip(history, id))
);

ipcMain.handle("follow-up", (_e, { mode, question, answer, history }) => {
  const cleanQ = String(question || "").replace(/^❓\s*/, "").slice(0, 60);
  const label = `${FOLLOWUP_LABELS[mode] || "➕ More"} — ${cleanQ}`;
  return runAnswerTask(label, (id) =>
    generateFollowUp(mode, question, answer, history, id)
  );
});

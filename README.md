# Interview Helper

<p align="center"><img src="assets/icon.png" width="128" alt="Interview Helper" /></p>

A companion app for (practice) interviews: it runs in the background on your own
machine, transcribes the conversation in real time, and instantly provides
compact AI answer suggestions for detected questions. All AI calls run through
**Replicate** — a single API key is all you need.

## Features

- **Two separate audio channels**
  - *System audio (loopback)* → the other participants' voices (e.g. from Teams/Zoom/Meet)
  - *Microphone* → your own voice
  - The full conversation is captured with clean per-speaker attribution.
- **Speech segmentation (VAD)** in the client: utterances are detected via an
  energy threshold, finalized on pauses, and sent to Replicate as WAV. Long
  statements are split into configurable segments (default 1 s) and transcribed
  while the speaker is still talking.
- **Transcription** via a freely selectable Replicate model
  (default: `openai/gpt-4o-mini-transcribe`).
- **Interview-flow awareness**: the AI classifies every interviewer statement
  ([TOPIC] / [FOLLOW_UP] / [NO_ACTION]), threads the conversation by topic
  (📌 markers in both panels), answers follow-up questions with *additional*
  information only, and stays silent when everything is already covered.
- **Answer suggestions** via a freely selectable Replicate LLM with SSE
  streaming (default: `anthropic/claude-4.5-haiku`) — ultra-short, scannable
  format: the understood question as a ❓ line, then 1-2 key-point bullets.
- **Companion mode**: checks the conversation at a configurable interval (and
  immediately on questions) and shows helpful notes as a **persistent overlay**
  on a display of your choice. The overlay grows as a popup stack (never
  scrolls), keeps the thread visible while a question is open, appends
  follow-ups below, hides itself once the question is resolved, and can require
  confirmation before switching topics. Follow-up buttons (more / code /
  pros-cons / examples) sit directly on the overlay.
- **Screen analysis**: capture a predefined screen region on click and send it
  together with the conversation context to a vision model (default:
  `google/gemini-3-flash`) — results as short facts, optionally with a rendered
  Mermaid diagram.
- **Follow-up buttons on every answer card**: ➕ More, `</>` Code (with syntax
  highlighting), ⚖ Pros/Cons, 🧩 Examples.
- **Model selection**: all three models (STT / LLM / vision) are selectable in
  the settings. The dropdowns are populated live from the Replicate collections
  `speech-to-text`, `language-models` and `vision-models`; any `owner/name`
  model can also be entered manually. Choices are persisted, and the app reads
  each model's input schema automatically (audio/image field names,
  `language`/`system_prompt`/`max_tokens` support), so most community models
  work without code changes.
- **Multi-language**: German, English, Hindi, Chinese, Japanese, Spanish,
  French, or automatic detection — applied to transcription and answers.
- **Session cost estimate** in the top bar, **conversation management**
  (save / browse / delete, disabled while recording), and a **legal notice**
  that must be accepted before recording.

## Setup

```bash
npm install
npm start
```

On first start the legal notice and the settings open:

1. Enter your **Replicate API key** (r8_..., from https://replicate.com/account/api-tokens).
   Alternatively the `REPLICATE_API_TOKEN` environment variable is used.
2. Optionally refresh the model list and pick your STT / answer / vision models.
3. Fill in your **profile/context** (role, skills, projects) — it flows into every answer.

Then click **"Start recording"**:
- Windows asks for screen sharing → pick any screen
  (only the **audio** is used; the video track is discarded immediately).
- Allow microphone access.

## Notes

- System audio loopback works out of the box on **Windows** (Electron `audio: 'loopback'`).
- The key, model choices and saved conversations are stored locally in
  `%APPDATA%/interview-helper/`.
- For minimal latency pick small/fast models (e.g. `anthropic/claude-4.5-haiku`
  or `openai/gpt-5-mini` for answers). For better transcription accuracy,
  increase the segment length to 3-5 s.
- If you share your screen in a meeting, put the companion overlay on a display
  you are **not** sharing.
- Intended for practice and mock interviews. Recording real conversation
  partners requires their explicit consent (in Germany: § 201 StGB; GDPR
  applies additionally).

## Architecture

```
main.js               Electron main: windows, settings, Replicate calls
                      (predictions with "Prefer: wait" for STT, SSE streaming
                      for LLMs, Files API for larger uploads, per-model schema
                      detection, model lists from Replicate collections),
                      companion overlay + prompts, cost tracking, conversations
preload.js            IPC bridge (contextBridge)
overlay-preload.js    IPC bridge for the region-selection overlay
companion-preload.js  IPC bridge for the companion overlay
renderer/
  index.html          main UI (top bar, conversation bar, transcript, answers,
                      settings and legal dialogs)
  app.js              audio capture (getDisplayMedia loopback + microphone),
                      energy VAD + utterance segmentation, question detection,
                      interview-flow control-line parsing, topic threading,
                      rendering (Mermaid + highlight.js), conversations
  overlay.html/js     drag-to-select screen region
  companion.html/js   companion overlay (popup stack, auto-resizing, actions)
  pcm-worklet.js      AudioWorklet: Float32 → PCM16 @ 16 kHz
  vendor/             mermaid.min.js, highlight.min.js + theme (bundled locally)
```

## License

MIT — see [LICENSE](LICENSE). Bundled libraries: [Mermaid](https://mermaid.js.org/)
(MIT) and [highlight.js](https://highlightjs.org/) (BSD-3-Clause), both vendored
locally under `renderer/vendor/`.

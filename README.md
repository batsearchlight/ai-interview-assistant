# Interview Helper

<p align="center"><img src="assets/icon.png" width="128" alt="Interview Helper" /></p>

<p align="center"><em>A real-time AI companion that listens to your (practice) interview and quietly hands you the answers.</em></p>

## Why does this exist?

You know those **trivia-style interviews**? The ones where someone just fires
random questions at you, rapid-fire, one after another — "What are Angular
directives?", "How does a token bucket work?", "Explain event bubbling" — and
your brain picks exactly that moment to go completely blank?

That's the itch this scratches. Interview Helper runs quietly in the
background on your machine, listens to both sides of the conversation
(your mic *and* the system audio, so it knows who said what), transcribes
everything live, and the moment a question lands, a short, scannable answer
suggestion pops up. Not an essay. Not a lecture. Just the two or three key
points you need to sound like you didn't just panic.

It's built for **practice and mock interviews** — grinding trivia rounds,
rehearsing behavioral questions, drilling a specific topic before the real
thing. And since everything runs through [Replicate](https://replicate.com),
one API key gets you transcription, answers *and* vision — with every model
freely swappable.

## What it looks like

Left side: the live transcript, cleanly split between the interviewer and you.
Right side: the AI suggestions — each one starts with the question *as the AI
understood it* (super useful when speech recognition turns "Angular directives"
into "Angela directives"), followed by ultra-short bullets. Need more? Every
card has one-click follow-ups: **➕ More**, **`</>` Code** (with syntax
highlighting), **⚖ Pros/Cons**, **🧩 Examples**.

![Main window](assets/screenshots/main-window.png)

## It actually gets how interviews work

This is not a "throw every sentence at an LLM" app. Interviews have a rhythm:
a question gets asked → you answer → then either a **follow-up on the same
topic** or a **jump to the next one**. Interview Helper is built around exactly
that flow. Before answering anything, the AI classifies every interviewer
statement:

- **New topic?** → A 📌 topic marker appears in both panels and you get a fresh,
  short answer. Works even when it's not a grammatical question — "So, Angular
  directives." counts.
- **Follow-up on the current topic?** → You get an indented ↳ card with *only
  the new information*, building on what was already suggested. No repetition,
  no starting over.
- **Already covered / just small talk?** → Silence. No card. The app knows when
  it has nothing useful to add, which matters more than you'd think.

So instead of an endless soup of disconnected AI answers, you get a **threaded
conversation** that stays on topic, goes deeper when the interviewer digs
deeper, and moves on when they do.

## The Companion 🤖

Here's the problem with any interview helper: you can't keep squinting at a
second app while you're talking. People notice. It's awkward.

That's what **Companion mode** is for. Flip the toggle and the AI checks the
conversation on its own — at a configurable interval and instantly when a
question is detected — and when (and *only* when) it has something genuinely
helpful, a compact note fades in **as an overlay on whichever display you
choose**. Right next to your meeting window, on your second monitor, wherever
your eyes already are. No tabbing, no squinting.

<p align="center"><img src="assets/screenshots/companion-overlay.png" width="440" alt="Companion overlay" /></p>

The overlay behaves like a conversation thread, not a notification spammer:

- It **stays visible as long as the question is in the room** and disappears
  once you've answered it (the AI detects that too).
- Follow-up questions stack up as **additional popups underneath** — the window
  grows, nothing scrolls, nothing gets overwritten mid-sentence.
- If the interviewer is still refining their question ("well, what I actually
  mean is…"), the Companion waits instead of blurting out a wrong answer — and
  posts a "↳ Clarified" correction if the question shifts mid-flight.
- A full topic change can be gated behind a **confirmation** ("Switch / Keep"),
  so nothing yanks the current thread away while you're still using it.
- And yes, the follow-up buttons (More / Code / Pros/Cons / Examples) live
  right on the overlay too.

## Bonus round: screen analysis 📸

Sometimes the vital info isn't in the audio — it's on the screen. A shared
task description, a code snippet, an architecture diagram. Define a screen
region once, then hit **Analyze**: the app screenshots that region, sends it
together with the conversation context to a vision model, and gives you the
short version — key facts, numbers, edge cases, and (when a picture beats
words) a small rendered **Mermaid diagram**.

![Screen analysis and quick tip](assets/screenshots/main-window-analysis.png)

There's also a **💡 Quick tip** button (Ctrl+T) that takes nothing but the
conversation history and tells you the one thing worth saying next.

*All screenshots show fictional demo content.*

## The feature list, rapid-fire

- 🎙 **Dual-channel live transcription** — mic + system loopback, per-speaker
  attribution, client-side VAD, long statements split into configurable
  segments so text appears while people are still talking
- 🧠 **Interview-flow logic** — topic threading, follow-up detection,
  knows-when-to-shut-up classification
- 🤖 **Companion overlay** — persistent, auto-growing popup stack on any display
- 📸 **Screen region analysis** with vision models + Mermaid rendering
- 🔁 **Follow-ups everywhere** — more detail, code examples, pros/cons, examples
- 🔧 **Every model swappable** — STT, LLM and vision model picked from live
  Replicate collections (or type any `owner/name`); the app reads each model's
  schema automatically, so most community models just work
- 🌍 **Multi-language** — English, German, Hindi, Chinese, Japanese, Spanish,
  French, or auto-detect
- 💰 **Live session cost estimate** in the top bar
- 💾 **Conversation management** — save, browse and delete past sessions
- ⚖ **Built-in legal notice** that must be accepted before recording

## Getting started

```bash
npm install
npm start
```

1. Grab a Replicate API key from https://replicate.com/account/api-tokens and
   drop it into the settings (or set `REPLICATE_API_TOKEN`).
2. Optionally pick your models and fill in your **profile** (role, skills,
   projects) — it flows into every answer, and it's what helps the AI
   reconstruct garbled technical terms.
3. Hit **Start recording**, share any screen when Windows asks (only the audio
   is used), allow the mic — done.

## Good to know

- System audio loopback works out of the box on **Windows** (Electron
  `audio: 'loopback'`).
- Everything is stored locally in `%APPDATA%/interview-helper/` — key, model
  choices, saved conversations.
- Latency vs. accuracy is yours to tune: fast models
  (`anthropic/claude-4.5-haiku`, `openai/gpt-5-mini`) and 1 s segments for
  speed, bigger models and 3-5 s segments for quality.
- Sharing your screen? Put the Companion overlay on a display you're **not**
  sharing. 😉
- ⚖ **The serious part:** this is meant for practice and mock interviews.
  Recording real people requires their explicit consent — secretly recording
  non-public speech is a criminal offence in many jurisdictions (e.g. § 201 of
  the German Criminal Code), and GDPR applies on top. You are responsible for
  using this lawfully.

## Under the hood

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

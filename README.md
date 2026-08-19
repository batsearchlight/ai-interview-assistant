# Interview Helper

<p align="center"><img src="assets/icon.png" width="128" alt="Interview Helper" /></p>

Companion-App fuer (Test-)Interviews: laeuft im Hintergrund auf dem eigenen Rechner,
transkribiert das Gespraech in Echtzeit und liefert per KI sofort kompakte
Antwortvorschlaege zu erkannten Fragen. Alle KI-Aufrufe laufen ueber **Replicate**
— es wird nur ein einziger API-Key benoetigt.

## Funktionsweise

- **Zwei getrennte Audiokanaele**
  - *System-Audio (Loopback)* → Stimme der Gespraechspartner (z. B. aus Teams/Zoom/Meet)
  - *Mikrofon* → eigene Stimme
  - Dadurch wird der komplette Gespraechsverlauf sauber nach Sprecher getrennt abgebildet.
- **Sprach-Segmentierung (VAD)** im Client: Aeusserungen werden per Energie-Schwelle
  erkannt, bei Sprechpausen abgeschlossen und als WAV an Replicate geschickt.
- **Transkription** ueber ein frei waehlbares Replicate-Modell
  (Standard: `openai/gpt-4o-mini-transcribe`).
- **Fragenerkennung** (Deutsch + Englisch): Fragen des Interviewers werden automatisch
  erkannt, markiert und (bei aktivierter Auto-Antwort) sofort beantwortet.
- **Antwortvorschlaege** ueber ein frei waehlbares Replicate-LLM mit SSE-Streaming
  (Standard: `anthropic/claude-4.5-haiku`).
- **Modell-Auswahl**: Beide Modelle koennen in den Einstellungen gewaehlt werden.
  Die Auswahllisten werden live aus den Replicate-Collections `speech-to-text` und
  `language-models` geladen; es kann aber auch jedes beliebige `owner/name`-Modell
  eingetippt werden. Die Auswahl wird gespeichert.
- **Companion-UI**: Fenster optional immer im Vordergrund ("Pin"), Transkript links,
  KI-Vorschlaege rechts, manuelle Frage-Eingabe unten.

## Setup

```bash
npm install
npm start
```

Beim ersten Start oeffnen sich die Einstellungen:

1. **Replicate API-Key** eintragen (r8_..., von https://replicate.com/account/api-tokens).
   Alternativ wird die Umgebungsvariable `REPLICATE_API_TOKEN` verwendet.
2. Optional **"Modelle von Replicate laden"** klicken und STT- + Antwort-Modell waehlen.
3. **Profil/Kontext** ausfuellen (Rolle, Skills, Projekte) — fliesst in jede Antwort ein.

Dann **"Aufnahme starten"**:
- Windows fragt nach der Bildschirmfreigabe → beliebigen Bildschirm waehlen
  (es wird nur das **Audio** verwendet, das Videobild wird sofort verworfen).
- Mikrofonzugriff erlauben.

## Hinweise

- System-Audio-Loopback funktioniert unter **Windows** direkt (Electron `audio: 'loopback'`).
- Key und Modell-Auswahl werden lokal in `%APPDATA%/interview-helper/settings.json` gespeichert.
- Die App liest das Input-Schema des gewaehlten Modells automatisch von Replicate
  (Name des Audio-Feldes, `language`-/`system_prompt`-/`max_tokens`-Unterstuetzung),
  daher funktionieren auch die meisten Community-Modelle ohne Anpassung.
- Fuer minimale Latenz: kleine/schnelle Modelle waehlen (z. B. `anthropic/claude-4.5-haiku`
  oder `openai/gpt-5-mini` fuer Antworten).
- Gedacht fuer Test-/Uebungsinterviews. In echten Gespraechen gilt: Aufnahme/Transkription
  von Gespraechspartnern nur mit deren Einwilligung (in DE: § 201 StGB).

## Lizenz

MIT — siehe [LICENSE](LICENSE). Gebundelte Bibliotheken: [Mermaid](https://mermaid.js.org/) (MIT),
[highlight.js](https://highlightjs.org/) (BSD-3-Clause), jeweils lokal unter `renderer/vendor/`.

## Architektur

```
main.js          Electron-Main: Fenster, Settings, Replicate-Aufrufe
                 (Predictions mit "Prefer: wait" fuer STT, SSE-Streaming fuer LLM,
                 Files-API fuer laengere Audio-Chunks, Schema-Erkennung pro Modell,
                 Modell-Listen aus Replicate-Collections)
preload.js       IPC-Bruecke (contextBridge)
renderer/
  index.html     UI (Topbar, Transkript, Antworten, Einstellungen mit Modell-Auswahl)
  app.js         Audio-Capture (getDisplayMedia-Loopback + Mikrofon),
                 Energie-VAD + Aeusserungs-Segmentierung, Fragenerkennung, Rendering
  pcm-worklet.js AudioWorklet: Float32 → PCM16 @ 16 kHz
```

# Contributing

Thanks for considering a contribution! This is a small, focused project — the
process is deliberately lightweight.

## Getting set up

```bash
git clone https://github.com/batsearchlight/ai-interview-assistant.git
cd ai-interview-assistant
npm install
npm start
```

You'll need a [Replicate API key](https://replicate.com/account/api-tokens) to
actually exercise the AI features. Everything is plain JavaScript — no build
step, no framework. Edit, restart, test.

## Ground rules

- **English everywhere** — code, comments, UI strings, prompts, docs.
- **Keep answers short.** The whole point of the app is glanceable output;
  changes to prompts should preserve the ultra-short format.
- **No trackers, no telemetry, no cloud storage.** Everything stays local
  except the Replicate API calls the user explicitly configures.
- **Never commit secrets or real conversation content** — including in tests,
  screenshots and issue reports. Screenshots must use fictional demo content.
- Match the existing code style (vanilla JS, no semicolon golf, comments only
  where the code can't speak for itself).

## Pull requests

1. Fork, branch from `main`, make your change.
2. Make sure `npm start` works and CI passes (syntax check + pack smoke test).
3. Open a PR using the template. Small, focused PRs get reviewed fastest.

For bigger ideas, please open a feature request first so we can discuss the
approach before you invest time.

## Reporting bugs

Use the bug report template. The most useful reports include your OS, the
models you selected, and the exact error text — with all personal data removed.

## Security issues

Please **do not** open public issues for security problems — use
[private vulnerability reporting](https://github.com/batsearchlight/ai-interview-assistant/security/advisories/new)
instead. See [SECURITY.md](SECURITY.md).

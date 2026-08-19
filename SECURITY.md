# Security Policy

## Supported versions

Only the latest release is supported with security fixes.

## Reporting a vulnerability

Please report security issues **privately** via GitHub's private vulnerability
reporting: [open a security advisory](https://github.com/batsearchlight/interview-helper/security/advisories/new).

Do **not** open a public issue for security problems.

You can expect an initial response within a week. Please include reproduction
steps and the affected version/commit.

## Scope notes

- The app processes microphone audio, system audio, screenshots and transcripts
  and sends them to the Replicate API using the user's own key. Anything that
  causes data to leave the machine towards any other destination is a
  vulnerability.
- The Replicate API key is stored unencrypted in the local user profile
  (`settings.json`). Local-machine attacks (reading that file with user
  privileges) are outside the threat model, but anything that exposes the key
  to web content, logs, or third parties is in scope.
- The renderer runs with `contextIsolation` and without `nodeIntegration`;
  bypasses of that boundary are in scope.

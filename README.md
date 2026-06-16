# @benchagi/aurelius-bridge

The local **Aurelius agent-vault bridge** — the small program on a tenant's Mac that pairs
to their BenchAGI workspace and runs a supervised listener so the web `/aurelius` surface can
reach the tenant's **local** Claude. Inference always runs on the paired Mac via the tenant's
own Claude plan; no inference is ever initiated from BenchAGI servers.

This is the canonical home for the `aurelius` CLI + the `runtime/bridge/*` modules. It is
consumed by the BenchAGI CLI (`bench link` drives it) and shipped to customers via Homebrew.

## Install

```sh
brew install BenchAGI/tap/aurelius-bridge
# or
npm install -g @benchagi/aurelius-bridge
```

## Use

```sh
# Zero-touch: pair using your Bench sign-in (no code). `bench link` does this for you.
aurelius link --id-token <firebase-id-token>        # or pipe it: ... | aurelius link --id-token -

# Code path (fresh Mac / not signed in): pair with an 8-digit code from the web app.
aurelius pair 12345678

# Run the bridge listener under launchd (auto-start on login, restart on crash).
aurelius bridge install
aurelius bridge up
aurelius bridge status

aurelius bridge listen      # run the listener in the foreground (what launchd invokes)
aurelius bridge down        # stop
```

## How it works

- **Pairing** (`runtime/bridge/pairing.mjs`) exchanges an 8-digit code (`/api/v1/aurelius/bridge/pair`)
  or, zero-touch, a Firebase ID token (`/api/v1/aurelius/bridge/pairing/self`) for a tenant-scoped
  bridge JWT, and writes a credential to `~/.openclaw/agents/aurelius-<principal>/bridge-credential.json`
  (mode `0600`).
- **Listener** (`runtime/bridge/listener.mjs`) heartbeats `/api/v1/aurelius/bridge/heartbeat` and holds
  an SSE connection to `/api/v1/aurelius/bridge/events`; together these drive the web troubleshooter to
  `connected`. Incoming chat turns run on the local Claude CLI (`runtime/bridge/claudeRunner.mjs`) and
  stream back over the bridge.
- **Supervision** (`aurelius bridge install`) writes a `com.benchagi.aurelius-bridge` launchd agent.

## Requirements

- macOS, Node.js ≥ 20, and the `claude` CLI on `PATH` (the tenant's own Claude plan).

No runtime npm dependencies. Tests: `npm install && npm test`.

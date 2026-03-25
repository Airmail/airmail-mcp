# Airmail MCP

## Overview

Node.js stdio bridge that forwards JSON-RPC between AI clients (Claude, Gemini, Codex) and Airmail's native MCP server on localhost:9876. All tool logic lives in Airmail's Swift code — this package is just the transport layer.

## Architecture

```
AI Client ←stdio→ src/index.ts (Node.js) ←HTTP→ Airmail.app (localhost:9876)
```

- **src/index.ts** — the bridge. Uses raw TCP sockets (not http module) because Airmail's NWListener closes connections immediately after sending.
- **scripts/sync-tools.mjs** — parses Swift source files to extract tool definitions into manifest.json. Requires local Airmail Swift sources at `../airmailmac/PostinoNG191/PostinoNG/SwiftCore/MCP`.
- **manifest.json** — tool definitions used by the MCPB extension format.

## Commands

```bash
npm run build          # compile TypeScript
npm run sync-tools     # sync tool defs from Swift source → manifest.json
./scripts/release.sh   # sync + build + bump + commit + push + GitHub release
```

## Release flow

`./scripts/release.sh [patch|minor|major]` does everything:
1. Syncs tools from Swift source
2. Builds TypeScript
3. Bumps version in package.json
4. Commits and pushes to main
5. Creates a GitHub Release
6. GitHub Actions publishes to npm via OIDC (no token needed)

## Tool architecture (Swift side)

Tools are statically compiled into Airmail's binary. There is no plugin system or config file — adding a tool requires Swift code changes.

Two independent access control layers:
- **Capability groups** — control visibility in `tools/list`. Toggled at runtime via `manage_capabilities`. Disabling a group hides tools but does NOT block execution.
- **Permissions** — control execution. Three levels: `allow` (immediate), `ask` (macOS alert), `blocked` (rejected). Configured in Airmail Preferences → MCP.

`sync-tools.mjs` auto-discovers all `AMZMCP*Tools.swift` files — no hardcoded list. New tool files are picked up automatically.

Dispatch uses chain-of-responsibility: `AMZMCPToolRouter.dispatch()` tries each module's `handle(name:arguments:)` in sequence. First non-nil result wins.

## Deep links

MCP tools return `airmail://` URLs in responses. These open Airmail to the relevant content (message, composer, folder, attachment, settings). Deep link builders live in `AMZMCPBridge.swift`. Full reference in the Airmail source at `SwiftCore/MCP/docs/DEEPLINKS.md`.

Commands: `message`, `open`, `compose`, `reply`, `draft`, `archive`, `delete`, `view`, `attachment`, `settings`, `send`.

## Key details

- `prepublishOnly` runs `sync-tools` which needs local Swift sources — CI uses `--ignore-scripts` to skip it
- Auth token is read from macOS Keychain automatically; `AIRMAIL_MCP_TOKEN` env var overrides
- Package published under npm account `airmailapp` via GitHub Actions OIDC Trusted Publishing

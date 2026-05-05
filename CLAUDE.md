# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Node.js stdio bridge that forwards JSON-RPC between AI clients (Claude, Gemini, Codex) and Airmail's native MCP server on localhost:9876. All tool logic lives in Airmail's Swift code — this package is just the transport layer.

## Architecture

```
AI Client ←stdio→ src/index.ts (Node.js) ←HTTP→ Airmail.app (localhost:9876)
```

- **src/index.ts** — the bridge. Uses raw TCP sockets (not http module) because Airmail's NWListener closes connections immediately after sending.
- **scripts/sync-tools.mjs** — parses Swift source files to extract tool definitions into manifest.json. By default it reads `../PostinoNG191/PostinoNG/SwiftCore/MCP`; pass a path argument or set `AIRMAIL_MCP_SWIFT_DIR` for a different checkout layout.
- **manifest.json** — tool definitions used by the MCPB extension format.

## Commands

```bash
npm run build          # compile TypeScript → dist/
npm run watch          # tsc --watch
npm run sync-tools     # sync tool defs from Swift source → manifest.json
./scripts/release.sh [patch|minor|major]   # full release; must be on main branch
```

There is no test suite and no linter configured. Don't invent `npm test` / `npm run lint` invocations.

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

MCP tools return `airmailmcp://` URLs in responses. These open Airmail to the relevant content (message, composer, folder, attachment, settings). Airmail still accepts `airmail://` for legacy links, but MCP/AI traffic should use `airmailmcp://`. Deep link builders live in `AMZMCPBridge.swift`. Full reference in the Airmail source at `SwiftCore/MCP/docs/DEEPLINKS.md`.

Commands: `message`, `open`, `compose`, `reply`, `draft`, `archive`, `delete`, `view`, `attachment`, `settings`, `send`.

## Key details

- `prepublishOnly` runs `sync-tools` which needs local Swift sources — CI uses `--ignore-scripts` to skip it
- Default auth uses Airmail's per-client pairing flow; the bridge keeps its client token in memory for the current process
- `AIRMAIL_MCP_REMEMBER_CLIENT_TOKEN=1` persists the bridge client token under Keychain service `com.airmail.mcp.client`
- `AIRMAIL_MCP_AUTO_LAUNCH=1` lets the bridge open Airmail when the local MCP server is unreachable; default is no auto-launch
- There is no global Airmail MCP auth token; bridge access is pairing-only and revocable per client
- Package published under npm account `airmailapp` via GitHub Actions OIDC Trusted Publishing

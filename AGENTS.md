# Repository Guidelines

## Project Structure & Module Organization

This repository is a thin Node.js bridge between MCP clients and Airmail's native MCP server on `localhost:9876`. Keep the layout small and focused:

- `src/index.ts`: the only runtime source file; handles stdio, auth lookup, process launch, and raw TCP/HTTP forwarding.
- `scripts/sync-tools.mjs`: generates `manifest.json` from local Airmail Swift sources.
- `manifest.json`: packaged tool metadata.
- `scripts/release.sh`: release automation for version bump, push, and GitHub release.
- `logo.png`, `README.md`, `AGENTS.md`, and `CLAUDE.md`: package metadata and contributor context.

Build output goes to `dist/` and should be treated as generated code.

## Build, Test, and Development Commands

- `npm install`: install the TypeScript toolchain.
- `npm run build`: compile `src/` to `dist/` with `tsc`.
- `npm run watch`: rebuild on file changes during local development.
- `npm run sync-tools`: refresh `manifest.json` from the local Swift MCP source tree.
- `./scripts/release.sh patch|minor|major`: run the full release flow from `main`.

There is no `npm test` or `npm run lint` target in this repository. Do not document or add them unless the project introduces them first.

## Coding Style & Naming Conventions

Use TypeScript with strict compiler settings and ES module syntax. Follow the existing file style in `src/index.ts`: double quotes, semicolons, concise helper functions, and clear constant names such as `AIRMAIL_PORT` and `REQUEST_TIMEOUT_MS`. Prefer small, direct changes in the single bridge entrypoint instead of introducing new abstractions without need.

## Testing Guidelines

There is currently no automated test suite. For changes, verify by running `npm run build` and, when relevant, exercising the bridge locally against Airmail on macOS. Document any manual verification steps in the PR.

## Commit & Pull Request Guidelines

Use short, imperative subjects and a body that explains behavior, release, or compatibility impact. Keep commit messages specific; avoid placeholder subjects like `fix`, `update`, or `changes`.

PRs should include a brief summary, note any user-visible behavior changes, mention manifest or release-script updates when applicable, and link the related issue. Include screenshots only if documentation or packaging assets changed.

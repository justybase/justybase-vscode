# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

`AGENTS.md` (imported above) is the single source of truth for commands, architecture, parser/LSP conventions, and testing rules. Keep new guidance there rather than duplicating it here.

## Quick reference

- Setup: `npm install` at the repo root (Node >=22.12, npm workspaces over `packages/*`).
- Before finishing a change: `npm run check-types && npm run lint && npm run build`; for broader changes `npm run verify:pr`.
- Single test: `npx jest src/__tests__/sqlParser/sqlParser.test.ts --runInBand`
- Parser work: run `NODE_ENV=test npx jest src/__tests__/sqlParser --runInBand --no-cache` and keep dialect parser cold construction under 2000 ms.
- Never use `npm version`; use `node scripts/version-sync.js check`.
- `packages/sql-core` must not import `vscode`; the Netezza driver is imported only from `packages/netezza-runtime`.

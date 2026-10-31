# Telegram Claude Code Implementation Plan

> **For agentic workers:** Execute inline, sequentially, using the executing-plans
> and test-driven-development skills. No parallel agents, per user preference.

**Goal:** Prepare a private Telegram-controlled Claude Code agent for Render.

**Architecture:** One long-polling worker with the official Agent SDK. Persist
workspaces, transcripts, offset, and job status on one mounted disk.

**Tech Stack:** Node 22, TypeScript, Claude Agent SDK, native fetch, node:test.

**Spec:** ../specs/2026-10-30-telegram-agent-design.md

## Global constraints

- claude-sonnet-5-5; high; auto; no silent fallback or permission bypass.
- Owner-only private messages; one instance and one job at a time.
- No live inference or paid provisioning during preparation.
- No bot-enforced billing cap or budget reservations; 50 turns; 20-minute timeout.
- Never commit credentials or read unrelated vault entries.

## Task 1: Validated configuration, state, file/message boundaries

Files: package.json, tsconfig.json, src/config.ts, src/state.ts, src/safety.ts,
tests/core.test.ts. Interfaces: loadConfig(env), StateStore.open(path),
store.save(), authorized(message, owner), chunks(text), safeFile(root, path).

- [x] Add tests before implementation, run `npm test`, confirm failure.
- [x] Implement config validation, atomic JSON persistence and interrupted-job
  recovery, path checks and message redaction/chunking.
- [x] Run `npm test` and `npm run typecheck`.

Behavior fixtures: absent owner throws; owner 123/private chat 123 accepts while
group chat -123 denies; `../secret` rejects; `.env` rejects; an emoji spanning
the chunk boundary survives; stored running job restarts as interrupted.

## Task 2: Agent runner and Telegram transport

Files: src/agent.ts, src/telegram.ts, tests/agent.test.ts,
tests/telegram.test.ts. Interfaces: runner.run(request, emit, abort),
Telegram.call(method, payload), Telegram.send(chatId, text).

- [x] Write failing tests for exact SDK option propagation, resume, unexpected
  model/mode errors, completed result, and redaction/chunking at the HTTP boundary.
- [x] Implement using the installed SDK's real types and isolated HTTP fixtures.
- [x] Run tests and typecheck without credentials or network inference.

SDK contract fixture: requested model/effort/mode/cwd/resume must be passed to
query; init model mismatch interrupts; result success returns cost/session/text;
missing result errors, and no retry runs the same task again.

## Task 3: Bot controller and polling lifecycle

Files: src/controller.ts, src/main.ts, tests/controller.test.ts,
tests/polling.test.ts. Interfaces: Controller.handle(message),
Controller.stop(), poll(telegram, store, handle, signal).

- [x] Test unauthorized silence, busy rejection, stop, project/session isolation,
  uncapped job admission, restart recovery, offset-before-dispatch and error handling.
- [x] Implement commands, document transfer, cancellable jobs and bounded shutdown.
- [x] Re-run all tests, typecheck, build and secret-free config preflight.

## Task 4: Deployment packaging and instructions

Files: Dockerfile, docker-entrypoint.sh, render.yaml, .env.example,
.gitignore, .dockerignore, README.md, .github/workflows/ci.yml.

- [x] Pin dependencies/lockfile; configure non-root after mounted-disk initialization.
- [x] Prepare a single Render worker with persistent disk and secret placeholders.
- [x] Document BotFather, numeric owner ID, limits, usage, rollback and backups.
- [x] Validate YAML/Blueprint against its schema, audit production dependencies,
  run final tests/build; explicitly record unavailable Docker/live tests.
- [x] Review own changes and hand off exact missing inputs; do not deploy.

## Execution notes

Completed inline; one final read-only reviewer ran only after implementation,
with no concurrent model-heavy development. No Git repository existed; files are
kept in their own new project directory without touching sibling projects or
creating a remote. See `VERIFICATION.md` for evidence and remaining live checks.

Owner-requested follow-up: removed per-task/daily spending caps, retired budget
configuration and state fields, preserved other execution controls, and refreshed
the docs and source archive. Regression tests cover uncapped SDK requests,
continued job admission, obsolete environment values and legacy state migration.

# Project Management Tools Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan serially. The user has authorized implementation and deployment; continue within that scope.

**Goal:** Let Claude create, inspect, edit, switch, archive, restore and delete the owner's real bot projects through natural conversation.

**Architecture:** Add a project catalog with immutable directory IDs and editable metadata. Expose it through a dedicated MCP server and the existing Telegram controller. Defer project switches/self-closure until the current task succeeds, then continue remaining work in the real destination cwd with the original deadline.

**Tech Stack:** Existing TypeScript, Node 22, Zod, Claude Agent SDK 0.3.314, Telegram API and version-1 JSON state. No new service or database.

**Spec:** `docs/superpowers/specs/2026-11-14-project-tools-design.md`.

## Global constraints

- Preserve existing files, chats, shared uncapped memory, accounting, settings and credentials.
- Immutable project IDs remain filesystem directory names and cross-record keys.
- Project Trash lasts 48 hours; immediate purge requires an authenticated owner callback.
- A deferred action or continuation never applies after a failed/cancelled parent task.
- Handoffs retain the original task deadline; no billing cap, retry bypass or automatic replay.
- Run tests serially; keep private credentials and operational evidence outside Git.

## Task 1: Durable project catalog

**Files:** Create `src/project-state.ts`, `src/projects.ts`, `tests/projects.test.ts`; modify `src/state.ts`, `src/automation.ts`, `src/sessions.ts`, `src/background.ts`.

**Interfaces:** `ProjectCatalog(dataDir, store, secrets)`: `initialize`, `workspace`, `create`, `list`, `get`, `update`, `rename`, `archive`, `trash`, `restore`, `purge`, `purgeExpired`, `listFiles`, `assertIdle`. Shared `projectAcceptsWork(state, id)` guards automation and background work.

- [x] Write and run failing behavior tests for the catalog API, legacy folders, stable rename and preserved linked records. Example assertion: `assert.equal(await catalog.workspace(project.id), originalDirectory)` after `rename`.
- [x] Add optional validated project metadata and serialized catalog operations, safe directory discovery and paginated redacted views.
- [x] Add archive/Trash/restore, busy guards, paused schedules/cancelled queued tasks, safe idempotent purge and fallback project selection. Prove a sibling sentinel survives purge.
- [x] Block work/retries for unavailable projects and preserve individual session Trash deadlines.
- [x] Run focused project/automation/session/background tests and typecheck; commit the independently testable catalog.

## Task 2: Callable tools and real workspace handoff

**Files:** Create `src/project-tools.ts`, `tests/project-tools.test.ts`; modify `src/agent.ts`, `src/controller.ts`, `src/automation.ts`, `src/state.ts`, agent/controller tests.

**Interfaces:** `projectServer(context)` returns an SDK MCP server; `PROJECT_TOOL_NAMES` contains exact auto-approved MCP names. `ProjectToolContext` supplies the catalog, task project and host-owned request/cancel callbacks. `Task.deadlineAt` carries the original deadline into a continuation.

- [x] First reproduce missing MCP discovery and missing create/switch continuation using the real in-memory MCP transport and controller fixture. Assert the continued runner's `cwd` equals the new workspace and its session belongs to that project.
- [x] Register the twelve tools and normal auto permissions, with host-owned deferred operations and a no-execution hook while a change is pending.
- [x] Apply selection/closure only after successful finalization. Continue only supplied remaining work; preserve original deadline and new owner instructions. Add regression tests for Stop, failure, cancellation and destination becoming unavailable.
- [x] Run MCP/agent/controller regressions and typecheck; commit.

## Task 3: Menus and backups

**Files:** Modify `src/controller.ts`, `src/main.ts`, `src/backup.ts`, controller/backup tests; add `docs/project-tools.md`.

- [x] First reproduce legacy menu pagination and missing project metadata in encrypted backup round-trips. Assert an unauthorized purge callback cannot delete files.
- [x] Wire shared project services into commands, project status/detail/archive/Trash controls, authenticated confirmation and maintenance. Preserve `/project ID` compatibility.
- [x] Add optional project metadata to encrypted backups; validate all destinations before writes, preserve existing metadata and old payload support, and avoid resurrecting deleted projects.
- [x] Run focused menu/backup tests and commit.

## Task 4: Verify and release

- [ ] Run typecheck, build, diff/credential checks and the full Windows suite. Review the patch for lifecycle and path regressions.
- [ ] Push the candidate; run full serial Linux tests as production UID plus a bounded real Claude MCP create/switch/write/read acceptance in temporary data, with no second Telegram poller.
- [ ] Integrate without overwriting remote history and deploy the verified code to the existing Render worker. Compare disk/settings/reset flags and verify polling and retained memory/chat/accounting startup.
- [ ] Save private verification artifacts, update release documentation and refresh the tracked-source ZIP.

## Baseline

Base commit `db998afcb7c882cb3cafcd86c279a1d25fe1bf5a`; branch `feat/project-tools-20261114` in a separate workspace. The preceding release passed 220 Linux tests; this task reruns a clean baseline before changing production code.

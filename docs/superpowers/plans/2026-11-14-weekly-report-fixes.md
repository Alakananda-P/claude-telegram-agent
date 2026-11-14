# Weekly report fixes implementation plan

Execute serially with Systematic Debugging, Executing Plans and TDD. The owner approved the reviewed fixes with "kro fir".

**Goal:** Correct the report's privacy, conversation-version, helper-lifecycle, progress, formatting, delivery and memory-tool gaps without resetting user work.

**Architecture:** Preserve the controller, state store, pinned SDK and private deployment. Add shared safe inspection views and Telegram presentation helpers. Group SDK session versions only using proven durable bindings. Keep native SDK model helpers alive until their notifications are consumed, within the existing task timeout and normal permissions; durable scripts keep their existing independent lifecycle.

## Constraints

- Preserve chats, files, uncapped memory, usage, private environment and exact execution/retry inputs.
- No automatic deletion of suspected duplicate chats, credential revocation, command replay, safety bypass or billing cap.
- Fabricated secrets in tests only; no private report transcripts in repository commits.
- Inspection masking is not encryption or universal detection of arbitrary unlabelled passwords. Existing operational state and SDK transcripts remain private service data.
- The accepted scope is the reviewed bug list. Browser, OAuth, search-provider and new media integrations are separate roadmap requests.

## 1. Privacy boundary: H-07/H-11

Files: `safety.ts`, `automation.ts`, `workspace-tools.ts`, `sessions.ts`, `chats.ts`, controller metadata views, focused tests.

- [x] Reproduce raw task/schedule disclosure over the real MCP transport using fabricated secrets and a legitimate retry control.
- [x] Add allowlisted paginated task views with project/status filters, sanitized summaries and no raw prompt/steer/legacy fields. Apply safe serialization to schedules and other metadata responses.
- [x] Extend shared masking for recognizable provider tokens and labelled secrets/identity numbers; sanitize before pagination, preview truncation and button labels. Preserve ordinary amounts, GSTINs and code placeholders.
- [x] Run focused trigger, alternate input and compatibility tests, typecheck and nearby regressions. Obtain one fresh read-only candidate review. Three review findings confirmed and covered by regressions: truncated schedule labels, archive persistence versus presentation, legacy configured-secret titles. Commit together with overlapping session changes.

## 2. Conversation versions: H-22

Files: `sessions.ts`, `controller.ts`, `chats.ts`, `state.ts`, session/controller/recovery/backup tests.

- [x] Reproduce a credit-recovery session change and a binding chain. Assert one visible conversation with preserved historical versions.
- [x] Resolve chains with cycle protection, group only proven same-project versions, preserve titles, task references, Trash and restore.
- [x] Align owner selection, list/count/read tools and historical version access; never infer duplicate deletion from matching text.
- [x] Run regressions and commit. Typecheck and 84 focused tests pass, zero skips.

## 3. Model helpers and progress: H-05/H-02/H-03

Files: background service, `agent.ts`, `controller.ts`, `workspace-tools.ts`, `state.ts`, focused tests.

- [x] Inspect pinned SDK task events and reproduce an outstanding helper at parent-turn completion.
- [x] Keep the native SDK query/input open after the parent's answer while non-ambient helpers run; consume completion results before closing. This replaces a second helper service because the pinned SDK already supplies task lifecycle and steering. Helpers share the existing task timeout/cancellation/restart boundaries and are not advertised as restart-durable.
- [x] Forward sanitized task progress to the activity indicator and preserve ordinary parent updates. Publish helper outcomes without hidden reasoning; provide a read-only audit agent and retain normal auto permission checks.
- [x] Record timeout, cancellation, refusal, API failure and restart reasons distinctly; preserve configured limits and no-replay behavior.
- [ ] Test lifetime, progress, cancellation, timeout, usage and restart; verify a real SDK path in Linux and commit.

## 4. Telegram formatting: H-21

Files: `formatting.ts`, `telegram.ts`, formatting/Telegram tests.

- [x] Reproduce raw Markdown, tables and unsafe HTML/code chunking.
- [x] Render escaped chunk-safe Telegram HTML, readable monospaced tables, headings, links and code. Retry plain text only on an explicit formatting rejection, never ambiguous delivery failures.
- [x] Verify request payloads and message tracking; commit.

## 5. Delivery and tool usability: H-06/H-08/H-09/R-06

Files: `artifacts.ts`, `safety.ts`, workspace/memory tools, background service, controller, focused tests.

- [x] Reproduce missing `.md` delivery, sensitive-document auto-delivery, hidden path errors, missing empty-topic deletion and log-head notifications.
- [x] Include Markdown outputs, skip clear identity/credential paths in automatic delivery, preserve explicit safe retrieval.
- [x] Expose safe typed path errors. Add serialized empty-topic deletion that refuses nonempty/core topics and symlinks.
- [x] Show final log lines and record notification timestamps after completion/send, retaining durable retries.
- [x] Run regressions and commit. Also preserve version bindings in backward-compatible encrypted backups. A 300 KB log test exposed a new quadratic URL-scheme masking path; bounded scheme matching fixes it (3.4 ms regression run).

## 6. Verify and deploy

- [x] Run typecheck, build and full serial tests. Review each report item as fixed, already implemented, unproven or separate roadmap work. Windows: 215 tests, 211 pass, four platform skips, no failures/cancellations; see `docs/weekly-report-fixes.md` for scope and evidence boundaries.
- [ ] Check the patch for private values; push reviewed changes and run Linux tests as production UID 1000 plus bounded real SDK/Telegram acceptance without a second poller.
- [ ] Integrate and deploy the tested revision to the existing Render worker. Verify the same disk/environment/reset flags and preserved memory/session/accounting readiness.
- [ ] Save private evidence and refresh the source archive; report measured results and evidence gaps.

## Baseline

Base `265311f3dbc92f4b159b108d211103c10697479c`; isolated `fix/weekly-report-20261114` worktree. Serial Windows suite: 191 tests, 187 passed, four platform skips, zero failures/cancellations, 26.1 seconds.

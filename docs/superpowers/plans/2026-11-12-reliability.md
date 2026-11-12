# Telegram agent reliability fixes

Status: in progress. Base: `f1ae5da`. Work in the isolated `fix/reliability-20261112` worktree. Preserve `/data`, shared memory, sessions, usage records, credentials and upgrade-reset settings.

## Scope and evidence

Source: the owner's `Bot_Issues_Report.md` and request to retire keys after 48 hours of continuous authentication failures. Memory storage is already uncapped; safety errors already have a structured category. These existing fixes must remain intact. A provider refusal must never cause automatic request replay, key rotation or model fallback.

1. Key retirement: an observed authentication-failure streak begins with a verified 401 and resets on any successful authentication or different observed failure. At/after 48 hours, a new verified authentication failure retires the key from routing and checks. Keep redacted history, including across restarts; do not infer a streak from the age of the last success. Retired secrets are not used even if an old deployment environment still contains them.
2. File delivery: automatically send supported deliverables from `output/` only. Preserve explicit `/get` and `deliver_file` for other safe project files. Never follow symlinks or deliver secrets.
3. Polling: record bounded outage history with start, end, duration and safe reason; keep retry/backoff and at-most-once update handling. Notify only for outages lasting at least one minute. A notification failure must not discard updates already fetched.
4. Safety continuation: provide an explicit owner action to open a fresh chat with a compact, visible summary of prior successful work. Preserve the old archive and memory, exclude rejected turns and raw attachments, and never automatically replay the stopped request.
5. Real user replies: distinguish notification-only completions from responses to human input; never mark unanswered owner input complete based only on a success result or emit the placeholder `No response requested.` as an answer. Preserve owner instructions and any completed side effects.
6. Background work: provide bot-owned project-script execution whose lifetime is independent of a model turn and selected chat, with status/log/cancel tools, resource limits, safe child environment and completion delivery. Persist metadata; mark interrupted work on restart rather than blindly repeating commands. Do not bypass denied tool permissions. Explain the SDK-native background-shell lifetime in the agent prompt.

## Execution checklist

### 1. Authentication retirement

- [x] Add failing deterministic tests in `tests/key-pool.test.ts`: exact 48-hour boundary, success/non-auth reset, legacy-history migration, late success not resurrecting a retired key, restart durability, all-retired empty routing and no further probes.
- [x] Extend `keyRecordSchema` in `src/key-pool.ts` with streak/retirement timestamps, retired status and history event. Migrate only a consecutive observed authentication-failure suffix.
- [x] Retire only on fresh failure; exclude retired credentials from active routing/checks and expose archived history in the existing keys menu.
- [x] Update `src/controller.ts` key menu callback and health counts.
- [x] Run key-pool/recovery tests, typecheck and inspect the diff; commit the subsystem.

### 2. Output delivery and polling

- [x] Add failing tests for output-only automatic delivery, ordinary CSV deliverables, symlink/secret exclusions and explicit file access.
- [x] Restrict `src/artifacts.ts` scanning to the real `output/` directory; align the agent prompt.
- [x] Add deterministic polling tests for short/long outages, persisted safe outage history, retry and fetched updates surviving recovery-notification failure.
- [x] Extend `src/polling.ts`, `src/state.ts`, `src/main.ts` and health display without changing update replay guarantees.
- [x] Run targeted tests and typecheck; commit.

### 3. Fresh continuation and reply integrity

- [x] Add fresh-summary tests excluding failed/refused turns and raw attachments; ensure old session and memory survive.
- [x] Add explicit `/fresh` and a safety-error action, including a preview of the compact continuation context.
- [x] Add synthetic SDK notification/human-message boundary tests. Track acknowledged owner input separately from internal notifications and require a substantive answer.
- [x] Preserve safety stops and completed tool effects; use bounded response repair only for otherwise successful empty/notification-only completions, with no action replay.
- [x] Run controller/steering/runner/safety tests and typecheck; commit.

### 4. Independent background execution

- [ ] Add a dedicated persistent background service with validated project scripts and arguments, separate child processes, secret-free child environments, bounded concurrency/output/runtime, safe cancellation and durable redacted logs.
- [ ] Add callable start/list/read/cancel tools and completion delivery independent of the active model query. Record restart interruption without replay.
- [ ] Test a real child process outliving the submitting turn, success/failure/cancel/timeout/restart, completion exactly once, secret and symlink protection.
- [ ] Update prompt/help and tests; commit.

### 5. Production verification

- [ ] Run the full suite, typecheck and build. Run Linux-only filesystem/process checks as the production `node` user in the deployed image.
- [ ] Push reviewed commits, deploy the exact commit to the existing Render service, and verify it becomes live with the same disk and reset flags.
- [ ] Verify active/retired key counts and fresh check classifications from safe production diagnostics. No credential values or user transcript contents in logs.
- [ ] Verify Telegram polling recovery, memory availability and a bounded representative runtime smoke test. Record evidence and remaining limitations before claiming completion.

## Validation record

- Baseline: prior `f1ae5da` verification recorded 166 tests (166 passing on Linux; Windows skips two filesystem cases), clean typecheck/build. This is a historical baseline, not verification of the new changes.
- New changes: pending.

- Key retirement: 22 key-pool/recovery tests passing; typecheck clean. Commit `a5bdc75`.
- Output/polling: 61 targeted tests, 60 passing and one Windows file-symlink skip; typecheck clean. Linux link checks remain required. Recovery-notification failure test confirms fetched owner updates are dispatched.

- Conversation fixes: 69 controller/agent/steering/recovery tests passing. Verified notification-only results do not consume human input, merged placeholders receive one tool-blocked correction, safety stops never replay, and `/fresh` excludes failed requests while retaining the source archive and memory.

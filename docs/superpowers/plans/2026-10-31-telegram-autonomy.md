# Telegram autonomy implementation plan

Goal: implement the full owner-approved photo, automation, recovery and data-management scope, test it, and deploy without resetting user data.

Architecture: keep the existing private single-worker bot and persistent /data disk. Extend the atomic state store with a durable queue, schedules, upload batches, health metadata and deletion tombstones. Add bounded in-process model tools for image editing, scheduling, delivery, session deletion requests and backup export. All actions remain owner-only.

Stack: TypeScript/Node 22, existing Claude Agent SDK, Telegram IPv4 transport, Sharp 0.35.5, cron-parser 5.10.2, authenticated AES-GCM backup exports.

Approved requirements and decisions:
- Direct photo receipt uses the largest supplied photo, stores originals and shows receipt/failure status. Captions and subsequent instructions refer to saved paths. Albums and manual batches wait for Process.
- Image tools crop, rotate, normalize contrast and deskew without overwriting originals. Uncertain bill fields require a crop and owner clarification; arithmetic validation is available as a deterministic tool.
- Generated artifacts are delivered automatically, with explicit model delivery available for crops/previews. Known secrets and restricted paths are never transferred.
- Ordinary tasks are durably queued. Queued work resumes after restart; interrupted execution requires an explicit retry to avoid repeating external actions. Queue controls include cancel, pause/resume, priority and history.
- Built-in clock defaults to Asia/Kolkata. One-time, interval and cron schedules persist, can be created/managed by the model, and enqueue jobs independently of incoming messages. Missed recurrences coalesce to one run, with next run advanced beyond now. Reminders need no Claude request.
- Session deletion requires an owner confirmation showing its title. Trash retention is exactly 48 hours from deletion. Restore cancels expiry. Purge deletes stored chat and SDK transcript, records a tombstone and preserves shared memory, project files and accounting.
- API recovery uses only configured approved credentials. Authentication/billing failures disable the affected key and can switch to a backup only before tool execution/output; ambiguous failures never blindly replay work. Rate limits/outages use bounded backoff, not key rotation. A fresh session plus bounded archived text is used on cross-key failover because signed thinking may be account-bound.
- Health panel separates Telegram connection, last successful Claude response, API credential status, queue, schedules and disk capacity. Alerts are deduplicated and sent when connectivity permits.
- Encrypted backup exports include chats, shared memory and schedules; optional project files have a size bound. The private Telegram chat provides a copy outside the Render disk. Restore validates every path, requires owner confirmation, merges rather than erases current chats, preserves live offsets/accounting and restores schedules paused. Backup keys never enter exports or model environments.
- No billing cap, browser feature, model substitution, chat reset or deletion of existing project files.

Execution checklist:
- [x] Persistent state, queue and clock/scheduler: add `src/automation.ts` and deterministic restart, recurrence, DST and duplicate-claim tests in `tests/automation.test.ts`.
- [x] Session trash: extend `state.ts`, `sessions.ts`, `chats.ts`; test exact expiry, restoration, re-import prevention and preserved accounting/files.
- [x] Photos and images: extend Message type/controller; add `images.ts`, `artifacts.ts`; test resolution selection, captionless references, album batches, image transforms, secret/path guards and auto-delivery.
- [x] Credential recovery: extend config/runner with `recovery.ts`; test success, revoked/credit failure, backup switching, no repeat after tools and no rotation on 429.
- [x] Backup export/restore: add `backups.ts`; test authenticated encryption, tampering/wrong keys, traversal, secret exclusion, restore merging and paused schedules.
- [x] Native Telegram control panels and model tools: wire `workspace-tools.ts`, controller/main/ui. Test owner isolation, batch processing, queued work, deletion confirmations and scheduled notification flows.
- [x] Documentation and full local verification: `npm run typecheck`, `npm run build`, `npm test`, `npm run check`, `git diff --check`; include realistic synthetic bill-image/receipt tests.
- [x] Secret-scan tracked content, push, deploy the immutable tested commit, check persistent disk identity, startup data counts, live provider response and Telegram polling. Run a bounded server feature smoke test that does not alter existing user data.

Deployment authorization: user explicitly requested all features, all tests and automatic deployment. No additional approval handoff is needed. Execute serially to respect the user's model-concurrency preference.

Local verification: 85 automated tests passed; typecheck, production build, private configuration check, and standalone acceptance smoke passed. Deskew output was visually inspected. Backup credentials and encryption were configured privately; one backup key passed a minimal Haiku request and model-access check. Production verification passed on runtime commit 8624d69b610d9de3a6d2e0f88c9211347910d142: Linux feature smoke, real Opus Fast/high with clock and bill-validation tools, encrypted backup delivery, unchanged persistent disk, retained chats/accounting, 25 registered commands, and healthy Telegram polling. Local live transport also verified photo upload/download and automatic file delivery; only synthetic test messages were removed.

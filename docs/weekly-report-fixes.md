# Weekly reliability changes

The November 14 review is implemented without clearing application data or changing credentials, model preferences, billing controls or the existing task timeout.

| Report item | Behavior and verification |
| --- | --- |
| H-07 / H-11: private task inspection | Task tools return paginated allowlisted metadata, with status/project filters and optional sanitized summaries. Recognizable credentials and labelled identity numbers are masked before preview truncation and button labels. Exact private execution/retry inputs stay intact. Fabricated-secret MCP and legacy-history regressions cover the disclosure paths. |
| H-22: repeated conversation versions | Saved same-project bindings group recovered SDK versions into one menu entry. Titles, older version reads, Trash, restore and encrypted backup links are preserved. Selecting a historical ID resumes its current version. Similar names alone never cause a merge or deletion. |
| H-05: helpers killed after parent reply | The SDK query stays open while non-ambient background work or its completion turn remains pending. Completion results are matched to their helper/run, so an overlapping owner reply or another helper cannot consume a pending hand-back. Owner steering remains open. A read-only audit helper is available. Native helpers share the current task's timeout, Stop control and worker lifetime; independent durable scripts keep their existing lifecycle. |
| H-02 / H-03: unclear stops and silent progress | Safe task summaries update activity indicators. Task records distinguish timeout, owner cancellation, shutdown/restart, API, safety, transcription and storage errors. `/status` shows the last reason. Each SDK provider attempt has its own cancellation signal: cleanup after a rejected key cannot cancel the owner task and prevent approved key recovery. Owner Stop still reaches the active attempt. The configured 20-minute limit explains a possible mechanism, not every historical cancellation. |
| H-21: raw Markdown | Replies render escaped Telegram HTML, headings, links, inline/fenced code and monospaced tables. Chunks close tags and preserve Unicode. Plain-text fallback happens only after an explicit entity-format rejection; ambiguous sends are not replayed. |
| H-06: automatic delivery | Changed Markdown files under `output/` join supported deliverables. Clearly identified identity/credential filenames are excluded from automatic delivery. Explicit permitted project-file retrieval still works. Existing project results are retained. Filename screening is not document-content classification. |
| H-08: generic path failures | File tools return safe typed errors for invalid paths, missing files, directories, symlinks and storage permissions without exposing server paths. |
| H-09: empty topic removal | `delete_memory_topic` removes an empty topic and refuses core, nonempty topics and symlinks. It shares the memory writer lock. Memory storage remains uncapped by the application. |
| R-06: completion previews and timing | Background completion notices use the log tail. Notification timestamps are recorded after successful delivery and never before job completion; failed sends retain durable retry state. |

## Evidence boundaries

The report's separate evidence directory was not supplied. Historical safety triggers, individual six-second stops, bill-reading mistakes and old generated workbook contents cannot be reconstructed from the report alone. Safety refusals remain distinct and are not automatically replayed or bypassed. Existing `/fresh` recovery remains available.

Browser, OAuth, additional search/media providers and accounting workflow redesign are separate roadmap work. No old chats, project files or credentials are automatically removed by this update. Similar unlinked conversations remain separate until the owner deliberately manages them.

## Validation

Validated code revision: `74ed456941a648412bcdbba91d85e2a927bd418e`.

Typecheck and build pass. The serial Windows suite has 220 tests: 216 passed, four platform-specific skips, zero failures or cancellations. The same revision passed 220/220 Linux tests as production UID 1000, including symlink, process-group and POSIX-permission paths.

A real Sonnet 5.5 SDK check started a read-only helper, kept it alive after the parent's interim reply, accepted an owner instruction, and delivered the helper's verified file marker. A real Telegram API check accepted the formatted HTML message and deleted only that test message; no second poller was started. The deployment record is saved separately in `data/weekly-report-verification.md` and its JSON companion.

Released on November 14 as Render deployment `dep-dbsa2ml6e07s739956m0`, running the validated code revision above. Production polling connected with zero recovery failures. The existing disk and inspected settings match the pre-deployment snapshot; chat reset and upgrade inference checks remain disabled. Documentation committed after release may differ from the deployed revision; runtime code and tests are identical.

# Project tools release - 15 November 2026

The Telegram bot now has twelve Claude-callable project lifecycle tools and a
named Projects menu. Runtime commit
[`0e96738`](https://github.com/Alakananda-P/claude-telegram-agent/commit/0e96738ff45d0680ebf068a07ced03084a8b7448)
deployed successfully to the existing Render worker at 00:39:32 IST. Telegram
polling reconnected at 00:40:05 IST with no recovered failures.

## Available behavior

- Create separate projects, list/search them and inspect descriptions and linked work.
- Rename projects or edit descriptions while keeping folder IDs and saved associations stable.
- Switch into the actual destination folder and continue only unfinished authorized work.
- Browse project files; use the existing Read, Write, Edit, Bash, Git and test tools to build and edit code.
- Archive, restore, move to 48-hour Trash, and request immediate permanent deletion with owner confirmation.
- Use `/projects` for named, paginated Active, Archived and Trash pages with file and lifecycle controls.
- Preserve project metadata in encrypted backups and accept older backup payloads.

For example: "Office Bills naam ka project banao aur usme invoice tracker banao."
Claude can invoke the tools from normal conversation; routine slash commands are
unnecessary. The complete tool table and deletion/restore behavior are in
[Project tools](project-tools.md).

## Validation

| Check | Result |
| --- | --- |
| Full Windows suite | 267 total: 262 passed, 5 platform skips, 0 failed |
| Full serial Linux suite, production UID 1000 | 267 passed, 0 skipped, 0 failed |
| Typecheck and production build | Passed |
| Whitespace and configured-credential scan | Passed; no configured vault credential found in tracked source |
| Code review | Reported lifecycle/input/persistence issues fixed; final focused review found no remaining concrete blockers |
| Real Claude Agent SDK | Sonnet 5.5, high effort: create project, request switch, continue in target, Write and Read the exact marker |
| Handoff checks | Source untouched; both tasks completed; correct actual directories, parent link and original deadline; project MCP connected |
| Telegram transport | Actual Projects panel sent once and deleted once; zero messages left by the probe; no second poller |
| Render deployment | Verified runtime commit live; project catalog reports all 12 tools; polling connected |

The live-model and transport probes used disposable temporary project data.
Three reported SDK estimates total approximately $0.2311, excluding hosting.
Early verification-driver assertions incorrectly assumed chronological queue
ordering and HTML menu payloads. The handoff check was corrected to follow the
parent ID; the plain-text panel was verified separately without another Claude
call. The application code did not need changes for those driver assumptions.

Regression coverage includes owner text, voice and media arriving during final
delivery or selection; Stop and failed turns; failed selection/enqueue saves;
restart interruption of uncertain handoffs; unavailable-project work; deletion
path boundaries; linked session cleanup; and backup compatibility.

## Existing data and configuration

Before/after inspection confirmed the same 10 GB `/data` disk, one worker, 1 CPU /
2 GB plan and Singapore region. Model/effort/fast/permission settings and disabled
upgrade-reset flags stayed the same. Startup recovered the existing 24 saved
chats, 64 accounting sessions and all 6 shared-memory topics (60,579 bytes).
Shared-memory storage remains uncapped by the application. One existing project
was discovered as active.

Historical accounting still reports `partial=true`; this release does not
reconcile old billing. Permanent project deletion preserves shared memory and
lifetime token/cost records. Exported backups and old Telegram messages remain
separate copies, as described in the project-tools guide.

Private deployment snapshots, probe results and verification logs are stored in
the ignored `data/` directory. The source archive contains tracked files only.

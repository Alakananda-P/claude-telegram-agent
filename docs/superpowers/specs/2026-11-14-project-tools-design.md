# Project lifecycle tools

The owner asked to add the tools needed to create, edit, manage and delete projects, building on the already discussed missing create/list/switch/rename/archive tools. Implement and deploy within that authorization.

## Behavior

- Add `list_projects`, `get_project`, `create_project`, `update_project`, `rename_project`, `switch_project`, `cancel_project_switch`, `archive_project`, `restore_project`, `delete_project`, `request_permanent_project_delete` and `list_project_files` as discoverable Claude MCP tools.
- Keep native Read/Write/Edit/Bash for code and file work. Project tools manage the bot's actual workspace selection and lifecycle, not just directories.
- Keep `/project ID` and `/projects` compatible; extend the Telegram Projects panel with details, active/archive/Trash pages, restore and deletion controls.
- Immutable project IDs remain filesystem directory names and the keys used by chats, tasks, schedules and uploads. Editable display names and descriptions live in optional version-1 state metadata. Renaming never moves directories or rewrites SDK transcripts.
- Discover existing valid project directories and referenced legacy projects without resetting data. Names, descriptions, lists and errors use the existing secret-safe presentation rules.

## Switching during work

The pinned SDK sets `cwd` when a query starts; its public Query API does not expose a cwd setter. See the [SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript) and the installed `sdk.d.ts`.

`switch_project` therefore requests a change after the current model turn succeeds. Its result explicitly says the current query still belongs to its original project. The model supplies only remaining work in an optional `continue_task` field when the owner asked it to switch and continue working. After the original task finishes and its outputs are delivered, the controller selects the destination and starts that remaining work in the destination's actual directory and saved chat. Completed actions are not replayed. A switch without remaining work selects the project for the next message.

While a switch or self-archive/delete is pending, normal execution tools are denied by a host hook; list/get and switch cancellation remain available. A new owner message can cancel or revise the request. No switch/continuation is applied on Stop, timeout, safety/API/storage failure or shutdown. Handoffs share the original deadline; they do not extend the existing 20-minute runtime limit. Running or interrupted work is never automatically replayed after a restart.

## Archive, Trash and permanent deletion

Archive preserves files and history indefinitely, pauses schedules and cancels queued work. Delete moves the project to a clearly labelled 48-hour Trash. Restore preserves files and histories but leaves cancelled work and schedules for explicit review/resume. Individually trashed chats retain their original deadlines.

Mutations that close a project refuse a live background job or another active task. Closing the current task's own project is deferred until the model reply and artifact delivery finish; an available project is then selected, creating a fresh fallback only if necessary. Display-name edits are safe during work because the ID and directory remain fixed.

Immediate permanent deletion uses an owner-only Telegram confirmation button, following the existing session-deletion interaction. There is no model-supplied `confirmed` argument. Expired Trash is purged by the existing maintenance tick. Persist a `purging` marker before irreversible work so an interrupted purge can resume safely. Verify the absolute deletion target is a direct child of the workspaces directory and reject symlink roots. Remove project files, chat archives/transcripts, schedules, upload references and completed background logs; retain global memory and lifetime model accounting. Keep a project tombstone to prevent accidental resurrection or ID reuse.

## Persistence and compatibility

Project mutations are serialized. Backups gain optional project metadata, preserve display names and archived status, continue to read old backups and never restore into a trashed/purged project implicitly. Archived/trashed projects cannot receive new scheduled work or task retries. Project Trash is hidden from the normal session selector without extending individual chat Trash deadlines.

## Validation

Cover legacy migration, pagination, metadata persistence and redaction; stable paths after rename; work/schedule guards; archive/Trash/restore and 48-hour expiry; safe purge and outside-directory/symlink sentinels; backup compatibility; real MCP discovery/calls; correct directory/chat for automatic continuation; owner steering/Stop/failure during a pending switch; deadline preservation; and Telegram menu/confirmation authorization. Run the full serial Windows and Linux suites, then a bounded real SDK create/switch/write/read check in isolated data, before deploying to the same Render worker and disk.

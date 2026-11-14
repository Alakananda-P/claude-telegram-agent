# Project tools

Claude can manage real projects from ordinary Telegram instructions. For example:

> Create a project called Office Bills and build an invoice tracker in it.
>
> Rename project office-bills to Supplier Accounts and describe what it contains.
>
> List my projects, inspect the files in office-bills, then continue working there.
>
> Archive the old prototype. Move the abandoned demo to Trash.

`/projects` opens named, paginated Active, Archived and Trash pages. Each project
has details, file browsing, name/description guidance, open, archive and deletion
controls. `/project ID` remains a shortcut to create an empty project or resume
an existing active one. `/rename` changes a chat title; project names use the
project tools.

| Tool | Behavior |
| --- | --- |
| `list_projects` | Paginated status/search, names, IDs and live counts |
| `get_project` | Description, lifecycle state and linked work counts |
| `create_project` | New separate folder, optional stable ID and description |
| `update_project` | Edit display name and/or description |
| `rename_project` | Change the display name while keeping the same folder |
| `switch_project` | Select the target after a successful turn; optionally continue unfinished work there |
| `cancel_project_switch` | Cancel this turn's pending switch or self-closure |
| `archive_project` | Keep files and chats indefinitely; pause schedules and cancel queued work |
| `restore_project` | Restore from Archive or unexpired project Trash; work remains paused |
| `delete_project` | Move the project and its linked content into 48-hour Trash |
| `request_permanent_project_delete` | Ask the owner to confirm immediate permanent deletion in Telegram |
| `list_project_files` | Paginated directory browsing, including other active/archived projects |

Standard Claude Code Read, Write, Edit, Bash, Git, dependency and test tools handle
code inside the current project. These twelve tools add project lifecycle control;
they do not turn a name change into a filesystem move. IDs remain fixed so saved
chats, uploads, schedules, scripts and SDK paths keep their association.

## Switching the actual workspace

An SDK query's working directory is fixed. A switch request is therefore honest
about being pending: execution tools pause, the current turn finishes, and the
host opens the destination's actual folder and saved chat. `continue_task` carries
only remaining owner-authorized work. Completed actions and the original request
are never automatically replayed. A switch without remaining work simply selects
the target for the owner's next message.

The continuation keeps the original task deadline. Stop, failure, refusal, storage
failure or shutdown prevent a pending switch/self-closure from applying. A new
owner instruction or incoming media cancels the pending change. Text, captioned
attachments and voice instructions reach the active conversation; a bare upload
still waits for a prompt. Claude must reevaluate and request the change again if
still appropriate. Changes stay cancellable through final-answer delivery and
selection persistence. Failed handoff saves cancel staged continuations and
recover the previous selection; a worker restart marks unstarted handoffs
interrupted for explicit review rather than running uncertain work.
Already completed file edits are preserved. Switching does not stop an independent
background job, but a live job blocks archiving/deleting its project.

## Archive, Trash and permanent deletion

Archive is indefinite. Project Trash starts a 48-hour deadline and hides the
project's chats from normal selection. Restoring the project keeps each individually
deleted chat's own deadline. It does not restart cancelled tasks or paused schedules.
Normal project deletion is reversible during that window.

The maintenance worker permanently purges expired project Trash. Immediate purge
uses an expiring, single-use confirmation associated with the authenticated owner.
The model can request that button; it cannot confirm deletion itself. Permanent
purge removes the project's workspace, saved chat/draft archives, SDK transcripts
(including unbound interrupted turns), uploads, schedules and background logs.
Task records lose their private prompt/attachment content. A tombstone prevents
silent recreation or reuse of the deleted ID. Partial purges can resume.

Shared long-term memory, lifetime token/cost accounting and other projects stay.
Shared memory may still contain deliberately saved project facts; ask Claude to
forget those separately when desired. Files in existing exported backups are
separate copies. Permanent project deletion does not revoke a backup already sent
to the owner or erase old Telegram bubbles.

Workspace roots must be regular direct children of the workspace directory.
Deletion refuses symlink roots, and nested symlinks do not delete outside targets.
Missing registered folders report a recovery error rather than silently creating
an empty replacement. File browsing omits secrets, symlinks and dependency caches.
Project names/descriptions reject credentials; model/UI views mask legacy secrets.

## Backups and migration

Existing project folders and saved associations are discovered automatically.
There is no reset of chats, shared memory, offsets, settings or usage.

Encrypted backups now include optional project metadata, preserving names,
descriptions and archived state. Old version-1 backups still import. Existing
target metadata and files are not overwritten; schedules restore paused. Trash
and purged projects are excluded from exports, and imports refuse to resurrect
a local trashed/purged project. Restore that project explicitly first if its
48-hour restore period is still open.

The SDK API used for the host-managed switch is documented in the
[official TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript).

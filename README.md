# Private Telegram Claude Code agent

Send tasks to your own Telegram bot and run Claude Code on a persistent Render
worker. The worker keeps working when your laptop is off. This hosts the agent
software, not Claude model weights.

Configured defaults: **Claude Opus 5.5 (`claude-opus-5-5`), Fast mode, high effort,
  `auto` permissions**. Model, effort and Fast preference can be changed with Telegram
buttons and persist across restarts. The menu includes **Fable 5.1, Opus 5.5
and Sonnet 5.5**, the latest models in those families as of 2026-10-31.
Fast preference defaults ON; it currently applies only to Opus 5.5 in this list.
No unrequested model substitution or
`bypassPermissions` is enabled.
The official Agent SDK bundles the Claude Code engine (pinned SDK 0.3.314 /
Claude Code 2.1.314). No separate Claude Code subscription is required for this
API-key setup.

## What it does

- Live steering is always on. While Claude works, new owner text and transcribed
  voice instructions join the active conversation instead of creating separate
  queued jobs. Pending attachments accompany the next instruction. The SDK reads
  updates at its next tool boundary; a message arriving after a turn ends continues
  in the same session. Long tool calls can delay pickup. Other projects stay isolated.
- Claude's ordinary assistant progress messages appear during substantial work and
  stay in the chat archive. Hidden thinking and subagent text are not forwarded.
  The temporary activity indicator refreshes with elapsed time while a tool runs,
  then disappears. Final text already shown is not sent twice.
- Steering messages are saved before delivery. Stop cancels pending input and voice
  processing; interrupted tasks require explicit retry. Explicitly paused processing
  never silently queues new chat messages. Scheduled jobs retain their durable queue.

- Voice notes automatically become instructions: ElevenLabs Scribe v2 transcribes
  them before Claude runs. Pending photos/files accompany the spoken instruction.
  Audio files and videos still wait for a caption/text task; recorded speech inside
  those attachments is content, not permission to execute commands.
- Claude can call `transcribe_media` for local audio/video whenever the task needs
  speech recognition. It detects language automatically, preserves the original
  language, and saves TXT plus JSON with speaker/timestamp information under the
  project's `transcripts/`. Originals remain untouched. Use `/get` or ask Claude
  to send a transcript; routine voice instructions do not spam transcript files.
- Set optional `ELEVENLABS_API_KEY` privately in Render. It is excluded from
  Claude's subprocess environment. The provider receives the selected media.
  Identical content/options reuse a persistent cache, including after restarts.
  `/cost` shows successful STT requests and minutes separately from Claude's cost;
  ElevenLabs is the billing authority. No billing cap is imposed. Incoming Telegram
  files remain limited to 20 MB; the tool accepts local media up to 50 MB.
- `/stop` cancels transcription as well as agent work. Failed transcription does
  not start Claude or retry automatically; saved tasks can be retried from `/queue`.
  Uncertain network outcomes may still be billed. Silence never becomes an instruction.

- Runs Claude Code's standard tools: shell commands, code/file editing, Git,
  dependency installation, tests and other tasks supported by the runtime.
- Uses Telegram private text, photo, video, audio and voice messages; only your numeric Telegram
  user ID may issue work. Groups and other senders are ignored.
- Saves a separate conversation for each named project. Files and transcripts
  survive redeploys when the `/data` disk is attached.
- Supports one task at a time, a single disappearing activity indicator, cancellation,
  uploads, downloads, and redacted result files for recovery after delivery errors.
- Telegram control panel: model, effort, speed, shared memory, saved sessions,
  tokens, cost, projects and task controls. Send `/menu` or tap the Menu button.
- Menus and operational notices disappear after five minutes without interaction.
  Navigation reuses its current panel and refreshes the timer. Completed settings/Trash
  actions close their panels after a three-second reading pause; batch receipts and queued
  notices close when their work moves on. Conversation replies, owner messages, reminders
  and delivered files remain. Cleanup records persist across restarts and failed deletions retry.
  `/menu` always reopens the controls. Panels created before this feature are adopted when
  clicked; unknown historical messages are never guessed or deleted. Telegram's normal
  message deletion window still applies.
- Long-term memory is on by default and shared across all projects/chats. `/memory`
  shows or changes it. `/memory remember TEXT` stores a note without an API call;
  the agent can also maintain concise durable preferences and project facts.
- `/new chat` clears the visible conversation and starts fresh while preserving
  project files, old sessions, memory and accounting. Selecting a saved session
  clears the visible chat and shows message previews in pages of six turns.
- Chats have persistent topic names in the session list and history pages.
  The active model can name or rename them, and `/rename TITLE` sets a name directly.
  Haiku 5.5 fills in missing names using a small excerpt, including for older chats;
  its tokens and SDK-reported cost enter the same usage journal. Each chat gets
  at most one helper attempt; provider failures keep a readable prompt-based name.
  Existing model/manual names are preserved. Naming runs sequentially, without Fast.
- Every selected model has `list_sessions`, `search_sessions`, `read_session`, and
  `rename_session` tools. It can count chats, find a past topic and page through
  saved text across projects without switching or clearing the current chat.
  Attachments are identified by filename; raw files, hidden reasoning and tool
  traces are not part of this text archive. Old messages are data, not instructions.
- While memory is ON, `read_memory`, `remember`, and `edit_memory` let the model
  save, correct or selectively forget durable facts. Memory OFF removes these
  tools. As before, it does not erase facts already in a resumed conversation.
- Usage is recorded per model in a durable journal. Completed and failed SDK
  results, streamed request usage, and recoverable historical cost snapshots
  are accounted for without repeatedly adding cumulative session totals.

- Photos use the largest Telegram rendition, with immediate receipt/failure feedback.
  Successfully saved uploads share one updating, buttonless receipt (for example, “📷 3 images
  received”). Counts include all waiting albums in the current chat; other documents have a
  separate file count. The receipt disappears when the files are submitted or after five idle
  minutes, without losing the pending uploads. `/batch` opens optional Process/Discard controls.
  Albums and manual batches wait for instructions or `/process`; captions and later instructions use saved paths.
- Direct Telegram videos, round video notes and animations use the same durable upload flow.
  One receipt counts images, videos, animations and other files separately; captionless clips wait
  for the next text prompt, while a standalone caption can start processing. Mixed photo/video
  albums wait for instructions or `/process`. Original files are saved, not just their thumbnails.
  The incoming limit remains 20 MB per file (Telegram cloud Bot API download limit); larger clips
  must be compressed or split. FFmpeg/ffprobe are included for metadata and bounded frame extraction
  when the agent processes a video. Receiving a clip does not mean its full contents/audio were analyzed.
- Image tools preserve originals and create crop, rotation, contrast and estimated deskew copies.
  Bill instructions require clarification for unclear writing; a deterministic tool checks quantities,
  rates and totals. These checks cannot guarantee recognition accuracy.
- A persistent queue serializes work. Queued work survives restart; interrupted work requires an
  explicit retry. The owner can cancel, prioritize or pause queued tasks and review recent history.
- A clock and durable scheduler support reminders, one-time tasks, intervals and cron with timezones.
  The model can create/edit/manage owner-requested schedules. India time is the default;
  missed recurring runs coalesce and reminders do not need an AI request.
- Generated supported files are sent automatically, up to 20 per task. Model delivery tools can
  send a relevant image crop or a particular finished file with a brief preview.
- Session deletion asks for confirmation, then moves the chat to Trash for 48 hours. Restore cancels
  expiry. Permanent deletion removes its archive and SDK transcript, with tombstones preventing
  import or backup restoration from resurrecting it. Memory, files and lifetime usage stay.
- A private key pool immediately tries the next eligible key on authentication, credit or server
  failures before any output/tool action, with no bot-added backoff between keys. The provider/SDK
  must first report the failure; this cannot remove network or SDK retry time. Each key is attempted
  once per failover chain. The working key remains preferred for later tasks and the title helper.
  Rate limits stay on the same account; account holds and verification restrictions block rotation,
  including on later tasks. Ambiguous failures and work with effects are never automatically replayed.
  Cross-key continuation uses bounded saved text in a fresh SDK session, preserving saved chats,
  files and memory. Model selection is never changed as a recovery strategy.
- `/keys` and **Key status** show non-secret labels, task/check counters, last success/failure/check,
  next check and paginated status-transition history. Hash identities and history persist on `/data`;
  raw keys and provider error text never enter the status store. Replacing a key creates a new identity.
  Healthy keys receive a one-output-token Sonnet check every six hours when idle; credit/auth/limit
  failures every 30 minutes, network/server failures every two minutes. Checks are serialized,
  abort when a task begins, survive restarts by their saved deadlines, and re-enable only on success.
  Successful check tokens and estimated cost enter the lifetime usage ledger. These checks establish
  basic API access, not a balance or access to every model/Fast tier. `/health retry` requests checks
  without blindly enabling keys or clearing history. Recovery does not replay failed tasks or unpause
  the queue automatically; use Queue to review/retry. The monitor runs in the existing Render worker.
- Encrypted backups export chats, shared memory and schedules to the private Telegram chat.
  Optional project files are bounded to 12 MB; encrypted exports are limited to 19 MB so the
  20 MB incoming Telegram limit permits restore. Restore merges missing data and pauses restored
  schedules; it never overwrites current files, offsets or lifetime usage. Usage journals and raw SDK
  transcripts are not in these portable exports; retain whole-disk backups for full disaster recovery.
  Keep `BACKUP_ENCRYPTION_KEY` privately; losing it makes encrypted exports unreadable.

This version does not include a web chat, voice synthesis, interactive terminal UI,
arbitrary plugins, or external MCP servers. Configured MCP servers are in-process handlers
for sessions, memory and the bounded workspace tools above. Standard tools run in a Linux
container. There is no desktop, GPU, Docker daemon, sudo, or access to your laptop.
Browsers and additional system packages require a Docker image update.
Project settings, hooks, and MCP configuration are not auto-loaded; enable
extensions only after reviewing them. This is not every interactive CLI feature
exposed through Telegram.

## Required before deployment

1. A dedicated Telegram bot token from [@BotFather](https://t.me/BotFather).
   Use `/newbot`, choose a name, and store the returned token privately.
   If reusing an existing bot, stop its old worker first. This app will not delete
   an existing webhook on your behalf.
2. Your **numeric Telegram user ID**, not your `@username`, bot ID, or token
   prefix. You can obtain it with a trusted ID helper bot, or inspect the `from.id`
   of your own private message using Telegram's `getUpdates` API from a private
   local client. Do not put tokens in browser URLs or paste them in chat.
3. A funded **Anthropic API key**, with access to Opus 5.5 Fast mode and auto-mode helper
   models. This build uses the direct Anthropic API, not an unverified API proxy.
4. A GitHub/GitLab repository containing **this folder's contents**.
   Do not publish the parent workspace or its shared `.env` file.
5. A Render account with billing enabled and approval for a paid worker and disk.

Credentials are supplied at runtime and remain separate from this repository.
The committed `.env.example` contains blank credential fields; real local values
belong only in the ignored `.env`. The Docker build context excludes env files.
On Render, enter the three private values in the service's environment settings;
do not upload the shared local credential vault or add keys to `render.yaml`.
GitHub and Render management tokens are not needed by the running bot.
A Render API key is not needed for dashboard deployment.

## Deploy to Render

1. Push only this project folder to your chosen Git repository.
2. In Render choose **New → Blueprint**, connect that repository, and select
   `render.yaml`. The proposed resources are one Singapore `1c-2g` worker
   (1 CPU / 2 GB RAM) and a 10 GB persistent disk. This is a starting size for
   lightweight coding; heavy builds may need more RAM. Review the current
   [pricing](https://render.com/pricing) and the dashboard estimate before approval.
3. Enter `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_ID`, and `ANTHROPIC_API_KEY` in
   Render's private environment inputs. Never commit them. Leave `DATA_DIR=/data`.
4. Confirm there is exactly **one instance**, and the disk is mounted at `/data`.
   Do not run this same bot token locally at the same time.
5. Review the usage limits below, then deploy. The Docker entrypoint initializes
   ownership of the fixed data directories and runs the application as `node`,
   not root. It prepares a persistent Python virtual environment for pip installs.
6. Open your bot in Telegram and press **Start**, then send `/status`.
   The initial online notice can fail harmlessly if you have not started the bot yet.
7. For a small **billable** acceptance test, send:
   `Create hello.py that prints hello, run it, and report its output.`
   Check the result, `/files`, and `/get hello.py`. Then redeploy while idle and
   verify the files and conversation remain available. Test `/stop` with a bounded
   task. These live tests were intentionally not run during local preparation.

No public URL, webhook endpoint, TLS domain, Redis, or Telegram login session is
needed. Telegram long polling is outbound HTTPS. Auto deploy is off to avoid
interrupting running tasks unexpectedly; deploy manually while idle.

## Commands

| Command | Action |
| --- | --- |
| Plain text or `/run TASK` | Start work in the current project |
| `/menu` | Telegram control panel with buttons |
| `/model fable`, `/model opus`, `/model sonnet` | Change model while idle |
| `/efforts low\|medium\|high\|xhigh\|max` | Change reasoning effort while idle |
| `/fast on` or `/fast off` | Save Fast preference; applies to Opus |
| `/token count` or `/tokens` | Lifetime input/output/cache tokens per model |
| `/cost` | Lifetime estimated Claude cost, with per-model breakdown |
| `/session` or `/session ID` | List/resume saved chats with paginated previews |
| `/memory` | Read memory and open its controls |
| `/memory on\|off\|clear` | Enable, disable, or clear shared memory |
| `/memory remember TEXT` | Save a durable note without model inference |
| `/status` | Current task, settings and execution limits |
| `/stop` | Cancel the current SDK run; does not undo existing effects |
| `/new` or `/new chat` | Clear screen and start fresh; preserve files, memory, usage and old chats |
| `/project NAME` | Create/switch project when idle |
| `/projects` | List project folders |
| `/files` | Bounded file listing (three nested levels, no secret folders) |
| `/get relative/path` | Download a file from the active project |
| `/help` | Usage guide |
| `/batch`, `/process` | Collect files, then process the batch |
| `/queue` | Task history, cancel/priority, pause/resume and explicit retry |
| `/schedules`, `/clock` | Scheduled jobs, controls and current time |
| `/trash` | Restore chats within 48 hours or delete permanently |
| `/backup` | Encrypted export, optional daily 03:00 IST export and restore guide |
| `/health` | Last Telegram/Claude success, API state, queue, schedules and disk |

Upload photos or documents up to 20 MB. A standalone caption starts a task about the saved file;
without a caption the upload waits for instructions or `/process`. Albums and manual batches always
wait for `/process` or a later text instruction. `/batch` opens controls for all waiting files. Names receive unique prefixes to
avoid overwriting existing files. Archives are not automatically extracted.
Downloads are limited to 49 MB. Hidden credential paths and symlinks are rejected
by the transfer layer; known configured credentials are refused in outgoing files.
Generic secret detection is not guaranteed—review artifacts before sharing them.

`/stop` also pauses the queue. Scheduled work joins the same serial queue, so a paused queue
delays reminders and scheduled jobs until resumed. Telegram recovery notifications are deduplicated
per outage; a stopped worker cannot send its own outage alert. No external uptime monitor is included.
The Health panel reports last successful events, not an API credit balance.

Set optional `ANTHROPIC_BACKUP_KEYS` to a JSON array of up to five privately configured keys.
Set `BACKUP_ENCRYPTION_KEY` to 32 cryptographically random bytes encoded as 64 hex characters.
Neither backup keys nor the encryption key enter the SDK subprocess environment. After fixing a
rejected credential, use Health → Re-enable fixed API keys; retry the failed task explicitly in Queue.

## Permissions, secrets and resource limits

`auto` is Claude's classifier-based mode, **not automatic approval of everything**.
It can block dangerous or ambiguous actions. Requests not approved automatically
are denied; the bot never escalates to bypass mode. Clarifications can be answered
in the next message. There are no approve/deny buttons in this version.
Claude's safety classifier may use a different Anthropic-selected model even
though the main agent uses your selected Fable, Opus or Sonnet model.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAX_TURNS` | `50` | Maximum model turns per task |
| `JOB_TIMEOUT_MINUTES` | `20` | Abort a task after this duration |

**There is no bot-enforced spending cap**, per the owner's request. The SDK receives
no `maxBudgetUsd` option, and no daily budget or reservation limits job admission.
The old `MAX_BUDGET_USD` and `DAILY_BUDGET_USD` variables are ignored if left in an
existing environment. Legacy reservation fields are removed from saved state
without losing conversations, job history or Telegram update offsets.

Cost estimates are informational only; they do not stop work. Provider
billing, credits and account limits remain outside this bot's control. API usage
and Render hosting still incur their normal charges. The turn limit, timeout,
single-job rule and `/stop` remain in place as execution controls, not billing caps.

## Chat UI, memory and accounting details

The Telegram API cannot create separate native private-chat tabs for a bot.
Session switching deletes tracked visible messages and renders a compact saved
overview with Older/Newer buttons. Telegram normally only permits deleting
messages less than 48 hours old; older messages may remain. Pre-upgrade history
is recovered from main Claude transcripts where available; those archives are
not a full Telegram export. Hidden reasoning, tool results and sidechains are
excluded from previews. Page summaries are extractive message previews and do
not make additional model calls. Exact saved text remains on the persistent disk.

`/data/memory/MEMORY.md` is shared across projects. Only useful durable facts and
preferences should be stored; credentials and raw bill contents should not be.
Memory is read into each new request. Turning it off prevents deliberate shared
memory access but cannot erase facts already present in an older conversation.
Use `/new chat` as well when you need a fresh context. Memory maintenance through
the agent is best-effort; explicit `/memory remember TEXT` is deterministic.

`/data/bot/usage.jsonl` records content-free usage. Result `modelUsage` snapshots
include query-pipeline subagents/compaction but omit some internal helper calls.
Stream deltas preserve known usage when a task is interrupted. Historical
`cost-state` snapshots restore older totals; where only assistant placeholders
survive, missing output tokens are not invented and the report is marked partial.
Cost is an SDK/list-price estimate, not an Anthropic invoice; other applications,
hosting and unreported requests are excluded. The official Claude Console is
the billing authority. Neither `/new chat` nor session switching resets usage.

Fast mode is requested through the SDK's `settings.fastMode`. `/status` shows the
latest provider-reported state; quota/capacity can cause cooldown or standard
speed. No fallback to a different model is accepted. Fast pricing is higher.

For an explicitly requested one-time migration reset, set
`RESET_CHAT_ON_UPGRADE=true` before deployment. The worker first imports saved
chats, then clears this bot's private Telegram conversation and starts a new
chat. An on-disk marker prevents repeated clearing on later restarts. Leave this
unset for normal installations.

`VERIFY_AGENT_ON_UPGRADE=true` opts into a one-time short, billable model
acceptance check. Its usage is counted in the ledger. A persisted attempt marker
prevents automatic retries; status logs contain only settings and success flags.

The agent receives a filtered subprocess environment without the Telegram token;
message output redacts known secrets. However, **this is a single-user trust
boundary, not strong isolation from the agent**. Arbitrary code under the same
OS identity can potentially inspect sibling processes, stored transcripts and
other project files. Prompt injection and arbitrary shell execution remain risks.
Do not put unrelated production secrets on this service, and use a dedicated
API key. For hostile repositories or multi-user use, build separate sandboxes and
a credential proxy before deploying. A non-root user alone is not a sandbox.

## Persistence and failure behavior

```
/data/
  bot/state.json          # offset, selected project, sessions, job status
  claude/                 # Claude Code session transcripts
  home/                   # persistent user caches and npm global prefix
  venv/                   # persistent Python virtual environment
  workspaces/PROJECT/     # uploaded files, repositories, results, generated code
```

The polling offset is saved **before** dispatch. This prioritizes avoiding duplicate
command execution: a crash in the small dispatch window can lose a message, and
the user must resend after inspecting project files. Running jobs are marked
interrupted on restart; they are never automatically replayed. `/stop` cannot undo
remote actions or guarantee termination of independently detached external jobs.
Use provider-specific checks if a task launched work outside this process.

Keep backups of the entire disk, including transcripts and bot state. A disk
snapshot is not a substitute for an off-service backup. To restore, stop the worker,
restore a consistent copy, then start one instance. Never clear the offset casually:
doing so could admit old queued Telegram work. If state is corrupt the bot fails
closed instead of discarding it. Disk-full job persistence disables new work.

For a code rollback, stop/wait for the active task and use Render's previous deploy;
do not delete the disk. A code rollback does not roll back edits already made in
workspaces. Avoid changing the `/data` path, which is part of session persistence.

## Local development (no credentials needed for tests)

```powershell
npm ci --ignore-scripts
npm test
npm run typecheck
npm run build
npm audit --omit=dev --audit-level=high
```

For a real local run, create `.env` from `.env.example` and fill the three private
inputs. `npm run check` validates configuration without network calls.
`npm run dev` starts a live worker and may incur usage when you send tasks.
Use Render/Linux for deployment; Windows local execution also depends on Claude
Code's supported shell environment. Never start it beside another instance.

To verify the container on a Docker-enabled machine:

```sh
docker build -t claude-telegram-agent .
docker run --rm --env-file .env -e DATA_DIR=/data claude-telegram-agent node dist/main.js --check
```

The second command validates startup with no inference. For a live container use
a named `/data` volume, supply secrets privately, and run just one instance.
GitHub Actions runs tests, typechecking, compilation, a production dependency
audit, Docker build, and a dummy-key no-network container startup check.

## Troubleshooting

- **401:** verify the bot token; never post the full error URL.
- **409:** another poller or webhook is using this token. Stop the other worker;
  the service refuses to take over silently.
- **No response:** press Start, check the numeric owner ID and private-chat context.
- **Configuration mismatch:** update/check the pinned SDK and account's model/auto
  access. Do not change to an older model or bypass permissions to hide the error.
- **Task failed:** check key funding, model access, resource limits and free disk.
  Raw provider errors are deliberately withheld. `/files` can recover partial work.
- **Repeated denied actions:** narrow the task or change the approach. Auto mode
  does not promise to execute every command.
- **Memory exhaustion:** use a larger worker for heavy builds; do not increase
  Telegram replicas because they would race on the same bot and disk.

## Primary references (checked 2026-10-30)

- [Sonnet 5.5 ID and high effort](https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5)
- [Claude permission modes](https://code.claude.com/docs/en/permission-modes)
- [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Official SDK repository](https://github.com/anthropics/claude-agent-sdk-typescript)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Render background workers](https://render.com/docs/background-workers)
- [Persistent disks](https://render.com/docs/disks)
- [Blueprint reference](https://render.com/docs/blueprint-spec)

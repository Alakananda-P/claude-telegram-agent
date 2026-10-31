# Private Telegram Claude Code agent

Send tasks to your own Telegram bot and run Claude Code on a persistent Render
worker. The worker keeps working when your laptop is off. This hosts the agent
software, not Claude model weights.

Configured defaults: **Claude Sonnet 5.5 (`claude-sonnet-5-5`), high effort,
`auto` permissions**. No model substitution or `bypassPermissions` is enabled.
The official Agent SDK bundles the Claude Code engine (pinned SDK 0.3.314 /
Claude Code 2.1.314). No separate Claude Code subscription is required for this
API-key setup.

## What it does

- Runs Claude Code's standard tools: shell commands, code/file editing, Git,
  dependency installation, tests and other tasks supported by the runtime.
- Uses Telegram private text/document messages; only your numeric Telegram
  user ID may issue work. Groups and other senders are ignored.
- Saves a separate conversation for each named project. Files and transcripts
  survive redeploys when the `/data` disk is attached.
- Supports one task at a time, periodic activity updates, cancellation,
  uploads, downloads, and redacted result files for recovery after delivery errors.

This first version does not include a web chat, voice transcription, photo-message
handling (send images as documents), scheduled jobs, interactive terminal UI,
arbitrary plugins, or configured MCP servers. Standard tools run in a Linux
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
3. A funded **Anthropic API key**, with access to Sonnet 5.5 and auto-mode helper
   models. This build uses the direct Anthropic API, not an unverified API proxy.
4. A private GitHub/GitLab repository containing **this folder's contents**.
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

1. Push only this project folder to your chosen private Git repository.
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
| `/status` | Current task, settings and execution limits |
| `/stop` | Cancel the current SDK run; does not undo existing effects |
| `/new` | Clear this project's conversation ID, preserve its files |
| `/project NAME` | Create/switch project when idle |
| `/projects` | List project folders |
| `/files` | Bounded file listing (three nested levels, no secret folders) |
| `/get relative/path` | Download a file from the active project |
| `/help` | Usage guide |

Upload documents up to 20 MB. A caption starts a task about the saved file;
without a caption the file is simply saved. Names receive unique prefixes to
avoid overwriting existing files. Archives are not automatically extracted.
Downloads are limited to 49 MB. Hidden credential paths and symlinks are rejected
by the transfer layer; known configured credentials are refused in outgoing files.
Generic secret detection is not guaranteed—review artifacts before sharing them.

## Permissions, secrets and resource limits

`auto` is Claude's classifier-based mode, **not automatic approval of everything**.
It can block dangerous or ambiguous actions. Requests not approved automatically
are denied; the bot never escalates to bypass mode. Clarifications can be answered
in the next message. There are no approve/deny buttons in this version.
Claude's safety classifier may use a different Anthropic-selected model even
though the main agent remains Sonnet 5.5.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAX_TURNS` | `50` | Maximum model turns per task |
| `JOB_TIMEOUT_MINUTES` | `20` | Abort a task after this duration |

**There is no bot-enforced spending cap**, per the owner's request. The SDK receives
no `maxBudgetUsd` option, and no daily budget or reservation limits job admission.
The old `MAX_BUDGET_USD` and `DAILY_BUDGET_USD` variables are ignored if left in an
existing environment. Legacy reservation fields are removed from saved state
without losing conversations, job history or Telegram update offsets.

Session cost estimates are informational only; they do not stop work. Provider
billing, credits and account limits remain outside this bot's control. API usage
and Render hosting still incur their normal charges. The turn limit, timeout,
single-job rule and `/stop` remain in place as execution controls, not billing caps.

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

# Telegram Claude Code agent

## Approved scope

The conversation establishes Telegram first, Anthropic API authentication, Claude
Sonnet 5.5, high effort, automatic permissions, and preparation before requesting
deployment inputs. The owner subsequently requested no bot-enforced billing cap.
The user asked to prepare everything; implement this agreed
scope locally without provisioning paid resources or making model calls.

## Architecture and tradeoffs

Use one Node.js/TypeScript Render Docker background worker, Telegram long polling,
and the official Claude Agent SDK. A webhook web service adds a public endpoint
and request/job coordination that this single-user bot does not need. A general
VPS offers greater system control but is outside the chosen Render setup.

Only messages from the configured numeric owner ID in that owner's private chat
are accepted. Polling is sequential, but an agent job runs asynchronously so
status and stop commands stay responsive. A second job is rejected as busy.
Persist Telegram update offsets before dispatch, never automatically replay work
after crashes, and mark interrupted jobs for the owner to retry explicitly.

Persist project files, Claude session transcripts, and bot state on /data.
Named projects have separate directories and session IDs. /new resets the active
conversation without deleting files. /project switches only while idle.

## Agent configuration

Use model claude-sonnet-5-5, effort high, permissionMode auto, the claude_code
tool/system-prompt preset, and no bypass permission flag. Reject unexpected
model/mode at initialization instead of silently substituting. Auto is the
classifier-based permission mode, not unconditional approval. The classifier
may use another Anthropic-selected model. Unresolved permission requests deny
and report; natural-language follow-up handles clarification. Load no project
hooks or MCP servers implicitly; explicitly configured extensions are future
work. Keep the SDK's full standard tool preset.

## Controls and files

Commands: /start, /help, /status, /stop, /new, /projects, /project NAME,
/files, /get RELATIVE_PATH. Text or /run TEXT starts a job. Upload documents
to uniquely named project uploads, optionally start work using the caption.
Restrict bridge downloads to regular files within the project, reject symlinks
and credential-like paths, cap transfer sizes, chunk Telegram messages safely,
redact configured secrets from text, and never log raw API errors.

## Resource and security boundaries

One instance, one task at a time. No per-job or daily billing cap, no SDK
`maxBudgetUsd`, and no budget reservations. Keep 50 turns and a 20-minute timeout
as execution controls. Session cost estimates are informational only. Provider
account limits and charges are not changed. Legacy accounting fields are removed
on load without losing work, conversations or polling offsets.
Run under a non-root container user. Agent subprocess env excludes bot credentials
and uses a persistent HOME. This is a single-trust container, not a security
boundary against arbitrary code or prompt injection: same-user processes and
mounted data may be accessible. Keep unrelated credentials off the service.

## Verification and handoff

Test configuration fail-closed behavior, owner/private authorization, message
chunking/redaction, path containment, persistence/restart recovery, SDK option
and event handling, job exclusivity/cancel, uncapped job admission, polling replay protection,
and HTTP contracts using deterministic fixtures/local servers. Typecheck/build
against the actual pinned SDK. Supply Dockerfile, Render Blueprint, env example,
CI, setup guide, and deployment checklist. Report separately that Docker/live
Telegram/Claude/Render checks remain unverified when unavailable.

## Inputs required for deployment

Telegram BotFather token, numeric owner ID, an approved funded Anthropic API key,
a Git repository to deploy from, and confirmation of a paid Render worker/disk.
Secrets go only in local ignored env or Render secret inputs, never chat or git.

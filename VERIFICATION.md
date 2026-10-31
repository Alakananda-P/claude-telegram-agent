# Preparation verification — 2026-10-31

## Verified locally

- `npm test`: **25 passing, 0 failing**, after the owner-requested removal of
  billing caps. Includes private-owner authorization,
  config validation, real auto-mode option propagation, model mismatch rejection,
  per-project session persistence, cancellation/timeouts, job exclusivity,
  uncapped job admission, legacy budget-state migration, uploads, safe path restrictions, Unicode chunks/redaction,
  local HTTP Telegram contracts, and offset-before-dispatch handling.
- `npm run typecheck`: passed against the installed official SDK types.
- `npm run build`: passed.
- `npm audit --omit=dev --audit-level=high`: **0 reported vulnerabilities**.
  This is a dependency database check, not proof of application security.
- `render.yaml`: passed JSON Schema validation against
  `https://render.com/schema/render.yaml.json` fetched during preparation.
- GitHub Actions YAML parsed successfully; shell entrypoint syntax check passed
  using the installed Git Bash.
- Compiled app `--check`, with dummy credentials: passed; no network/model calls.
- Local `npm run check` also passed after privately configuring the selected
  Anthropic key, dedicated Telegram bot token, and verified numeric owner ID.
  Telegram `getMe` and the owner's unique private setup message were verified.
  No credential values or owner identifiers are included in this repository.
- Independent read-only review of the initial preparation: no concrete blocking
  findings; that version's 23 tests reran successfully. The subsequent cap-removal
  change passed the expanded 25-test suite and local review; it was not separately
  reviewed by a second agent. No independent security audit was performed.

The two regression tests added during review reproduced missing mid-run model
validation and an inherited-property session lookup before their fixes.

## Not yet verified

- Docker image build/startup: Docker is unavailable on this workstation. CI includes
  a Docker build and dummy-key startup test, but CI has not been run remotely.
- Actual Anthropic key funding, Sonnet 5.5 access and auto-mode availability.
- Real Telegram delivery, API errors, file transfer and cancellation with Claude.
- Render disk permissions, persistent sessions across redeploy, Linux resource usage.
- Live shell/code execution through the agent (intentionally requires paid inference).

These are deployment acceptance checks, not claimed successes. No Render service
has been provisioned and no live model inference has been run. GitHub Actions
reports remote build results separately for each pushed commit.

## Inputs still needed

1. Connect the private Git repository to Render.
2. Set the three configured credentials/owner values in Render's private
   environment settings. The local values remain outside Git and Docker images.
   Anthropic funding and model access still require a deployment acceptance check.
3. Approve the dashboard's paid worker/disk estimate. Proposed configuration:
   Singapore, one `1c-2g` worker, 10 GB disk. No fixed price was assumed.

Do not send tokens, keys, account passwords or raw `.env` contents in chat.

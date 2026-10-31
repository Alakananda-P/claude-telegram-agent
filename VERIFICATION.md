# Telegram control panel upgrade — 2026-10-31

Local verification covers the Opus Fast/high default; Fable 5.1, Opus 5.5 and
Sonnet 5.5 selection; model/effort validation; owner-only messages and callbacks;
session persistence and previews; shared memory; request and cumulative usage
accounting; interrupted/error results; history migration; safe file handling;
Telegram transport and offset-before-dispatch behavior.

- `npm test`: 45 passing tests, including Telegram UI transport and reset contracts.
- `npm run typecheck`: passed against the pinned SDK 0.3.314 types.
- `npm run build`: passed.
- Current direct Anthropic Models API lists the three configured model IDs.
- No credentials, account identifiers, private conversations or deployment
  metadata belong in the Git tree. Runtime files are ignored and excluded
  from the Docker build context.

The SDK's installed Claude Code 2.1.314 binary confirms the transcript
`cost-state` format used for historical recovery. Result snapshots are cumulative
per resumed session; they are replaced, not summed. Step records use final
streamed usage where available. Lost/unknown usage is marked partial, not inferred
as authoritative billing. All reports exclude unreported helper calls and costs
from other apps or hosting.

The Render Docker build and live startup passed. A real one-shot request reported
Opus 5.5 / high / `usage.speed=fast`; its usage is counted in the ledger. Historical
accounting loaded without partial records, one old chat was recovered, and the
owner-requested Telegram reset succeeded. No chat contents were printed in logs.
Local Docker is unavailable. GitHub Actions status is checked separately.

Rollout exposed an old-container shutdown error: root tini could not forward a
signal to the unprivileged worker. The entrypoint now drops privileges before
starting tini, so init and the worker share a UID. Shell syntax validation passed;
the updated image is validated on Render during the follow-up rollout.

Telegram session pages contain extractive message previews, not a native chat
tab switch. Message removal remains subject to Telegram's 48-hour limit.
Memory maintenance by the model is best-effort; explicit memory commands are
deterministic. Auto permissions remain enabled, with no billing cap.

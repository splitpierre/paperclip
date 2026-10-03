# Bu Digital fork: backlog

Open items for `splitpierre/paperclip` (`bu/main`). Plans for larger items live next to this file.

## Requested features (from the fork kickoff, 2026-09-26)

- [ ] Mobile experience needs careful review and testing, some input fields make things unusable in some places
- [ ] **Trello connector.** Boards/lists/cards as a connection agents can use (read cards, create/move
      cards, comment). Decide: app definition + tool connection vs. plugin.

## Planned

- [ ] **Cross-thread awareness for agent conversations**: see `cross-thread-awareness-plan.md`
      (conversations only; ~500 lines, no migration).

## Context compaction: remaining (see `context-compaction-plan.md`)

- [ ] Context meter in task/chat headers (size, message count, "summarized through").
- [ ] Thread divider at the compaction cursor with "view summary / download archive".
- [ ] Company settings for compaction: compactor agent (today `PAPERCLIP_BU_COMPACTION_AGENT` in the
      systemd drop-in), soft threshold (48 KB), hard cap (96 KB).

## WhatsApp channel: small follow-ups

- [ ] Mark messages from **linked** people as read (blue ticks); never for unlinked senders.
- [ ] Title WhatsApp conversations "WhatsApp · <name>" instead of the first message.
- [ ] Optionally hide channel conversations from task lists (show them under the channel / agent chats).
- [x] Images reach the agent as attachments; voice notes are transcribed locally (faster-whisper,
      `scripts/bu/setup-whisper.sh`). Video/documents/stickers still arrive as a placeholder.
- [x] Composer mic button (web chat + task threads): dictate, transcribe locally, review, send.

## Platform fixes found along the way

- [ ] **Claude sign-in stores only the ~8 h access token** (`server/src/services/local-ai-credentials.ts`
      reads `claudeAiOauth.accessToken`, drops the refresh token), so shared Claude connections expire.
      Workaround in use: long-lived token from `claude setup-token` (`/data/tools/claude-long-token.sh`).
      Fix: use `setup-token` in the local sign-in flow, or store and refresh the full OAuth credential.
- [ ] Stranded-task recovery wakes an agent every minute on any assigned task left `in_progress`
      (`recovery/service.ts`, `issue_continuation_needed`). Consider a longer, backed-off interval.
- [ ] **`DELETE /projects/:id` 500s once the project has cost history.** `routes/projects.js:689` deletes
      the `projects` row directly; Postgres rejects it with `cost_events_project_id_projects_id_fk` because
      nothing deletes/reassigns that project's `cost_events` rows first. Hit 2026-09-28 migrating
      `micro-zombies` from Bu Digital to Split Systems (issues deleted fine; the project delete itself
      failed). Worked around by archiving the project instead of deleting it. Fix: either cascade/null out
      `cost_events.project_id` on project delete, or have the route pre-check and return a clear 409
      instead of a raw FK 500.
- [x] 2026-09-28: **Resume button for "Automatic recovery stopped".** `GET /issues/:id/recovery-actions/:actionId/diagnose`
      (`bu-recovery-diagnosis.ts`) proves "this run touched nothing" from its execution workspace (git:
      clean, 0 ahead, no matching remote branch, or no workspace at all) and its log (no tool-call
      markers); safe only when both hold. The UI's "Resume" button (`ExecutionBlockerNotice.tsx`) diagnoses,
      then submits through Paperclip's own `recovery-actions/resolve` — never bypasses it. Unsafe cases show
      the reason and change nothing, same as before.
      - [x] 2026-10-03: **Fixed a dead end found live on BUD-80 and SPL-29.** The diagnosis bailed out
            on any recovery action whose `status !== "active"` — but `execution-blocker.ts`'s own
            predicate (its "effective no-replay hold" comment) keeps surfacing a *resolved/cancelled*
            action as the current blocker when its evidence carries `automaticRecovery.replay ===
            "blocked"`, and the native `recovery-actions/resolve` handler already knows how to reopen
            exactly that action by id. Every such case had no automated path at all — had to resolve
            both by hand through the raw API. `diagnoseRecoveryAction` now recognizes that case and
            runs the normal safety checks on it instead of refusing outright; 3 new tests added
            (reopenable-and-safe, reopenable-but-unverified-side-effects, resolved-with-no-replay-hold).
- [ ] **DB connection leak: `listPendingFinalizeBlockerIssueIds` (`server/src/services/issues.ts:2367`).**
      2026-09-27: 10 connections stuck `idle in transaction` for 38+ min, all mid the exact same
      `workspace_operations` query (Postgres state `ClientRead` — it already answered; the app just never
      sent COMMIT), all opened within ~1s of each other. Exhausted the whole pool and took the server down
      (even `/api/health` hung). Called from `listIssueDependencyReadinessMap`, used on ~every agent wake
      (`heartbeat.ts:19933`) and issue-listing endpoints — the simultaneous cluster of 10 points at a batch
      wake/recovery sweep where something *after* this query, inside the same transaction, hangs forever.
      Not yet caught live (cleared it by killing the connections before catching the exact hang point).
      Mitigation proposed, not yet applied: set `idle_in_transaction_session_timeout` (e.g. 5 min) on the
      Paperclip DB role so this can't repeat as a full outage. Still open: reproduce with query logging and
      find the actual hung step.

## Housekeeping

- [ ] Retire the old WhatsApp plugin: uninstall `budigital.whatsapp-channel`, remove worktree
      `/data/projects/_worktrees/whatsapp-channel-v2`, close BUD-51/BUD-59, archive the plugin package in
      `bu-paperclip-adapters`.
- [ ] Remove unused AI connections ("My Claude subscription", "Bu Digital Anthropic Acc" personal,
      "My OpenAI subscription") once nothing references them.
- [ ] Turn sign-up off again after member testing (`auth.disableSignUp: true` in the instance config).
- [ ] Track upstream: rebase `bu/main` onto new release tags; re-run `scripts/bu/overlay-deploy.sh`
      after any `paperclipai update` (the update replaces the overlay).

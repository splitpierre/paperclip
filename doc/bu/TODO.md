# Bu Digital fork: backlog

Open items for `splitpierre/paperclip` (`bu/main`). Plans for larger items live next to this file.

## Requested features (from the fork kickoff, 2026-09-26)

- [ ] **Rename agents from the UI.** Today names are changed through the API/CLI (`agents/apply_personas.py`
      in `bu-paperclip-adapters`). Add an inline rename on the agent page.
- [ ] **Trello connector.** Boards/lists/cards as a connection agents can use (read cards, create/move
      cards, comment). Decide: app definition + tool connection vs. plugin.
- [ ] **Members page (`/BUD/company/settings/members`) rework.**
  - [ ] Owner can create members directly from the UI (email + role, set or send a password), no invite flow.
  - [ ] **Project-scoped members**: add a person to specific projects only, as *viewer* or *operator*,
        without company-wide access.

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
- [ ] Media: at least tell the sender that voice notes/images are not supported (today they are admitted
      as an "unsupported message" placeholder text).

## Platform fixes found along the way

- [ ] **Claude sign-in stores only the ~8 h access token** (`server/src/services/local-ai-credentials.ts`
      reads `claudeAiOauth.accessToken`, drops the refresh token), so shared Claude connections expire.
      Workaround in use: long-lived token from `claude setup-token` (`/data/tools/claude-long-token.sh`).
      Fix: use `setup-token` in the local sign-in flow, or store and refresh the full OAuth credential.
- [ ] Stranded-task recovery wakes an agent every minute on any assigned task left `in_progress`
      (`recovery/service.ts`, `issue_continuation_needed`). Consider a longer, backed-off interval.
- [ ] Recovery blocks ("Automatic recovery stopped", `legacy_execution_requires_reconciliation`) have no
      UI action; add a "confirm nothing happened, resume" button (the API is
      `POST /api/issues/:id/recovery-actions/resolve` with `executionReconciliation`).

## Housekeeping

- [ ] Retire the old WhatsApp plugin: uninstall `budigital.whatsapp-channel`, remove worktree
      `/data/projects/_worktrees/whatsapp-channel-v2`, close BUD-51/BUD-59, archive the plugin package in
      `bu-paperclip-adapters`.
- [ ] Remove unused AI connections ("My Claude subscription", "Bu Digital Anthropic Acc" personal,
      "My OpenAI subscription") once nothing references them.
- [ ] Turn sign-up off again after member testing (`auth.disableSignUp: true` in the instance config).
- [ ] Track upstream: rebase `bu/main` onto new release tags; re-run `scripts/bu/overlay-deploy.sh`
      after any `paperclipai update` (the update replaces the overlay).

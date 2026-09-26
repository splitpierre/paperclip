# Context compaction (Bu Digital fork)

Status: **proposed**, 2026-09-26. Fork: `splitpierre/paperclip`, branch `bu/main` (based on `v2026.916.1`, the release we run).

## Problem

Every wake of an agent on a task replays that task's **entire comment history**
(`buildExecutionContinuation` → `coverage.kind: "full_task_history"`), plus interaction
results, inside the wake payload. Nothing ever shrinks it:

- Bruna's BUD-51 grew from 37 KB to 145 KB of wake payload in four hours (34 comments,
  ~85 KB of message bodies, ~30 KB of interaction results).
- In this release the ACP engine also exports that payload as **one** environment variable,
  `PAPERCLIP_WAKE_PAYLOAD_JSON`. Linux caps a single env string at 128 KiB, so once a task
  crosses ~131 KB every run dies at spawn with `spawn E2BIG`. Upstream has since retired
  that variable ("wake context travels in the prompt"); our release still sets it.
- Even below the cap, a fresh provider session (no resumable Claude/Codex session) pays for
  the whole history on every turn: slow, expensive, and eventually past the model's window.

The envelope type already anticipates summaries (`coverage.summaryThroughCommentId`, always
`null` today). We fill that gap.

## Goals

1. No run ever fails because a task or chat is long (hard guarantee, independent of models).
2. Compaction works like Claude Code's `/compact`: history is replaced by a summary plus the
   recent tail, automatically or on request.
3. **The summary is produced in a separate, clean session** that only references the
   conversation being compacted. The session that needs compacting never does it itself.
4. Compacting **archives** the exact pre-compaction state (compressed) and keeps a
   **summarized** version that later turns use.
5. Same mechanism for **tasks** (issue threads, input box) and **agent chat**.
6. Nothing is deleted: the full thread stays visible in the UI and via the API.

## Phase 0 — stop the crash (small, ship first)

- `adapter-utils/src/acpx-engine/execute.ts` and the CLI-lane adapters
  (`claude-local`, `codex-local`, …): stop exporting the payload inline when it is large.
  Write it to the run scratch dir (`wake-payload.json`, mode 0600) and export
  `PAPERCLIP_WAKE_PAYLOAD_PATH`; keep `PAPERCLIP_WAKE_PAYLOAD_JSON` only under 32 KB.
- Update `skills/paperclip/SKILL.md` to read `PAPERCLIP_WAKE_PAYLOAD_PATH` when set.
- Test: a payload of 200 KB spawns fine; small payloads are unchanged.

This alone fixes Bruna's failure mode. Phases 1–3 fix the growth.

## Phase 1 — summaries in the continuation (server)

### Data

New table `issue_context_compactions`:

| column | notes |
|---|---|
| `id`, `company_id`, `issue_id` | |
| `status` | `queued` → `running` → `ready` \| `failed` \| `superseded` |
| `trigger` | `manual` \| `auto` \| `chat_command` |
| `requested_by_user_id`, `requested_by_agent_id` | who asked |
| `through_comment_id`, `through_created_at` | coverage cursor: every comment up to and including this one is covered |
| `previous_compaction_id` | summaries chain: a new one summarizes (previous summary + newer messages) |
| `summary_markdown` | the result, capped (default 12 000 chars) |
| `source_message_count`, `source_bytes`, `summary_bytes` | for the UI meter |
| `archive_path`, `archive_sha256` | gzip of the exact envelope that was compacted |
| `compactor_agent_id`, `compactor_run_id` | the clean session that produced it |
| `error`, `created_at`, `completed_at` | |

Archives live in `<instance>/data/context-archives/<companyId>/<issueId>/<compactionId>.json.gz`
(owner-only). The DB row is the index; the file is the frozen pre-compaction state.

### Continuation with a summary

`buildExecutionContinuation` looks up the latest `ready` compaction for the issue:

- `messages` = comments **after** `through_comment_id`, plus any `originCommentIds` that fall
  before it (the request that triggered this wake is never summarized away).
- New field `summary: { compactionId, markdown, throughCommentId, archivedMessages }`.
- `coverage.kind = "summarized_task_history"`, `summaryThroughCommentId = through_comment_id`
  (type widened from `null` to `string | null`).
- `renderPaperclipWakePrompt` renders the summary as its own section, marked as a
  server-authored digest of earlier messages, with a pointer to the full thread API for
  anything the agent needs verbatim.

For chats, the existing session boundary (`conversationBoundaryCommentId`) still wins:
nothing before a `/new` boundary is ever summarized into the current session.

### Safety net (guarantee #1)

After building the envelope, measure its serialized size. If it exceeds the **hard cap**
(default 96 KB), keep the summary (if any) and the newest messages that fit, drop older ones,
and set `coverage.kind = "truncated_task_history"` with `omittedMessageCount` and the API
pointer. The run proceeds; an auto compaction is queued (below). A run can never again carry
an unbounded history.

## Phase 2 — the compaction run (a separate clean session)

`services/context-compaction.ts`:

1. **Request** (`requestCompaction(issueId, trigger, actor)`): refuses if one is already
   queued/running for the issue; snapshots the current envelope (as the agent would see it,
   including the previous summary) and writes it gzip'd to the archive path; stores the
   cursor = newest comment in the snapshot.
2. **Run**: wakes the **compactor agent** with a brand-new task key
   `compaction:<compactionId>` and **no `issueId`** in the run context, so it cannot touch the
   target task's execution lock, provider session, or continuation. The prompt (template in
   `server/src/prompts/compaction.md`) points at a transcript file rendered from the archive
   (Markdown, one section per message with author + time) in the compaction run's scratch
   dir, and asks for a structured summary: goal, decisions, current state, open questions,
   artifacts (branches, PRs, files, issue ids), people and preferences, next steps. It must
   write `summary.md` next to the transcript and also return it as the final message.
3. **Finalize** (hook on run completion): read `summary.md` (fallback: `result_json.summary`),
   validate (non-empty, under the cap, mentions no secrets pattern), store, mark `ready`,
   mark older compactions `superseded`, and **drop the target task's provider session**
   (`agent_task_sessions` row for `(assignee, issueId)`), so the next turn starts fresh from
   summary + tail instead of resuming a bloated session. Post a small system comment on the
   task: "Context compacted: 34 messages → 2.1 KB summary (archive kept)."
4. **Failure**: status `failed` with the error; the safety net keeps runs working; the UI
   shows a retry button.

**Which agent compacts:** company setting `contextCompaction.agentId`. Empty = the task's own
assignee agent, but always in the fresh `compaction:*` session (same model family, clean
context, as in Claude Code). Recommended: point it at a cheap flat-rate agent (Fabio Zai)
so compaction does not eat Claude or OpenAI quota.

### Triggers

- **Manual, task**: `POST /api/issues/:id/compact` (board or the assignee agent) and a
  "Compact context" action in the task header menu.
- **Manual, chat**: typing `/compact` in the chat composer. Handled like `/new` in
  `agent-conversations.ts`: the command comment becomes a boundary, the session generation
  bumps, the provider session is dropped, **but** the compaction of everything before the
  boundary is carried into the new session as its summary. `/new` keeps meaning "forget".
- **Auto**: when a continuation built for a wake exceeds the **soft threshold** (default
  48 KB, ~12k tokens) and no compaction is queued/running, queue one with `trigger=auto`.
  The current wake proceeds (with the safety net if needed); later wakes get the summary.
  Company setting `contextCompaction.autoThresholdBytes` (0 disables auto).

## Phase 3 — UI

- Task and chat header: a context meter ("48 KB · 34 messages · summarized through #12")
  and the Compact action with a status chip (queued / running / failed → retry).
- In the thread: a divider at the compaction cursor, "Earlier messages summarized ·
  view summary · download archive".
- Company Settings → Context: compactor agent picker, soft threshold, hard cap.

## Tests

- Unit: envelope with/without summary, origin comments before the cursor kept, chat
  boundary respected, safety-net truncation keeps newest, size math.
- Service: request → run → finalize happy path (fake adapter returns a summary), failure,
  duplicate request refused, superseding, task session dropped.
- Adapter: 200 KB payload spawns (Phase 0).
- Manual end-to-end on this host: compact BUD-51's history, check the next run's payload
  size in `heartbeat_runs.context_snapshot`.

## Rollout

1. Phase 0 + Phase 1 safety net → deploy (fixes the crash class for good).
2. Phase 2 (compaction runs, manual + auto) → deploy, try on BUD-51 and one chat.
3. Phase 3 UI.

Deploy: push `bu/main` to the fork, then
`paperclipai install --ref <commit> --repo splitpierre/paperclip -y` (builds from source,
keeps the previous payload; `paperclipai update --rollback` flips back). A DB backup runs
first. Migrations are additive (one new table, nullable columns only).

## Keeping the fork mergeable

- Keep changes in new files where possible (`context-compaction.ts`, prompt template, UI
  components); touch shared files in small, marked hunks (`// bu-fork: compaction`).
- Track upstream: `git fetch upstream` and rebase `bu/main` onto new release tags; upstream
  already retired `PAPERCLIP_WAKE_PAYLOAD_JSON`, so Phase 0 drops out when we move to a
  newer base.

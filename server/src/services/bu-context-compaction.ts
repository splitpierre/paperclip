// bu-fork: context compaction (doc/bu/context-compaction-plan.md).
//
// A compaction summarizes an issue's history (task or chat) in a SEPARATE,
// clean agent run: the compactor is woken with its own task key
// (`compaction:<id>`) and no issueId, so it never touches the target task's
// execution lock, provider session, or continuation. The exact pre-compaction
// history is archived (gzip), and later wakes of the task get the summary plus
// the messages after it (see bu-context-budget.ts).
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  agentTaskSessions,
  agents,
  authUsers,
  heartbeatRuns,
  issueComments,
  issueContextCompactions,
  issues,
  type Db,
} from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";

export const COMPACTION_WAKE_REASON = "context_compaction";
const SUMMARY_MAX_CHARS = 12_000;
/** Messages newer than this many are kept verbatim instead of summarized. */
const KEEP_RECENT_MESSAGES = 4;

type Wakeup = (
  agentId: string,
  opts: {
    source: "automation";
    triggerDetail: "system";
    reason: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    requestedByActorType: "system";
    requestedByActorId: string;
    contextSnapshot: Record<string, unknown>;
  },
) => Promise<{ id: string } | null | undefined>;

let wakeupRef: Wakeup | null = null;

/** Called by each heartbeat service instance; any of them can start runs. */
export function registerCompactionWakeup(wakeup: Wakeup): void {
  wakeupRef = wakeup;
}

export type CompactionTrigger = "manual" | "auto" | "chat_command";

export interface RequestCompactionInput {
  companyId: string;
  issueId: string;
  trigger: CompactionTrigger;
  requestedByUserId?: string | null;
  requestedByAgentId?: string | null;
}

export type RequestCompactionResult =
  | { status: "started"; compactionId: string }
  | { status: "already_running"; compactionId: string }
  | { status: "nothing_to_compact" }
  | { status: "unavailable"; reason: string };

function compactorAgentRef(): string | null {
  const value = process.env.PAPERCLIP_BU_COMPACTION_AGENT?.trim();
  return value ? value : null;
}

function compactionDir(companyId: string, issueId: string, compactionId: string): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "data", "context-compactions", companyId, issueId, compactionId);
}

async function resolveCompactor(db: Db, companyId: string, fallbackAgentId: string | null) {
  const ref = compactorAgentRef();
  const rows = await db
    .select({ id: agents.id, name: agents.name, status: agents.status })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  const configured = ref ? rows.find((a) => a.id === ref || a.name.toLowerCase() === ref.toLowerCase()) : null;
  const chosen = configured ?? rows.find((a) => a.id === fallbackAgentId) ?? null;
  return chosen && chosen.status !== "terminated" ? chosen : null;
}

function renderTranscript(input: {
  issue: { identifier: string | null; title: string; description: string | null };
  previousSummary: string | null;
  messages: Array<{ author: string; createdAt: Date; body: string }>;
}): string {
  const parts = [
    `# Transcript: ${input.issue.identifier ?? ""} ${input.issue.title}`.trim(),
    "",
    "## Task description",
    "",
    input.issue.description?.trim() || "(none)",
    "",
  ];
  if (input.previousSummary) {
    parts.push("## Summary of everything before the messages below (from the previous compaction)", "", input.previousSummary.trim(), "");
  }
  parts.push("## Messages (oldest first)", "");
  for (const m of input.messages) {
    parts.push(`### ${m.author} · ${m.createdAt.toISOString()}`, "", m.body.trim() || "(empty)", "");
  }
  return parts.join("\n");
}

function compactionPrompt(transcriptPath: string, issueRef: string): string {
  return [
    "CONTEXT COMPACTION JOB. This is not a task and not a conversation turn.",
    "",
    `Read the transcript file at: ${transcriptPath}`,
    `It is the history of ${issueRef}, which has grown too long to replay on every turn.`,
    "",
    "Write a summary that lets an agent continue that work as if it had read the whole history. Use these sections:",
    "## Goal (what the human wants, in their words where it matters)",
    "## Decisions and constraints (including preferences and things the human rejected)",
    "## Current state (what is done, what is in progress, where things live: repos, branches, PRs, files, issue identifiers)",
    "## Open questions and pending requests",
    "## Next steps",
    "",
    "Rules:",
    "- Your final message must be ONLY the summary in Markdown, at most 8000 characters. No preamble.",
    "- Keep identifiers, paths, URLs, numbers and names exact. Never include secrets or tokens.",
    "- Do not call Paperclip APIs, do not post comments, do not edit files, do not change any task. Read the transcript and answer.",
  ].join("\n");
}

/** Starts a compaction of an issue's history in a separate run. */
export async function requestCompaction(db: Db, input: RequestCompactionInput): Promise<RequestCompactionResult> {
  if (!wakeupRef) return { status: "unavailable", reason: "heartbeat service not started" };
  const [issue] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
  if (!issue) return { status: "unavailable", reason: "issue not found" };

  const [active] = await db
    .select({ id: issueContextCompactions.id })
    .from(issueContextCompactions)
    .where(and(
      eq(issueContextCompactions.issueId, issue.id),
      inArray(issueContextCompactions.status, ["queued", "running"]),
    ));
  if (active) return { status: "already_running", compactionId: active.id };

  const [previous] = await db
    .select()
    .from(issueContextCompactions)
    .where(and(eq(issueContextCompactions.issueId, issue.id), eq(issueContextCompactions.status, "ready")))
    .orderBy(desc(issueContextCompactions.completedAt))
    .limit(1);

  const conditions = [eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id), isNull(issueComments.deletedAt)];
  if (previous?.throughCreatedAt && previous.throughCommentId) {
    conditions.push(sql`(${issueComments.createdAt}, ${issueComments.id}) > (${previous.throughCreatedAt.toISOString()}::timestamptz, ${previous.throughCommentId}::uuid)`);
  }
  if (issue.conversationAgentId && issue.conversationBoundaryCommentId) {
    // Chat: nothing before the current session boundary (/new) belongs to this session.
    conditions.push(sql`${issueComments.createdAt} >= (select created_at from issue_comments where id = ${issue.conversationBoundaryCommentId})`);
  }
  const rows = await db.select().from(issueComments).where(and(...conditions)).orderBy(asc(issueComments.createdAt), asc(issueComments.id));
  // Keep the most recent exchange verbatim; summarize everything older.
  const toSummarize = rows.slice(0, Math.max(0, rows.length - KEEP_RECENT_MESSAGES));
  if (toSummarize.length === 0) return { status: "nothing_to_compact" };
  const through = toSummarize.at(-1)!;

  const compactor = await resolveCompactor(db, issue.companyId, issue.assigneeAgentId ?? issue.conversationAgentId);
  if (!compactor) return { status: "unavailable", reason: "no compactor agent" };

  const agentIds = [...new Set(toSummarize.map((r) => r.authorAgentId).filter((v): v is string => Boolean(v)))];
  const userIds = [...new Set(toSummarize.map((r) => r.authorUserId).filter((v): v is string => Boolean(v)))];
  const agentNames = new Map(
    agentIds.length ? (await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))).map((a) => [a.id, a.name]) : [],
  );
  const userNames = new Map(
    userIds.length ? (await db.select({ id: authUsers.id, name: authUsers.name }).from(authUsers).where(inArray(authUsers.id, userIds))).map((u) => [u.id, u.name]) : [],
  );
  const messages = toSummarize.map((r) => ({
    author: r.authorAgentId
      ? `${agentNames.get(r.authorAgentId) ?? "agent"} (agent)`
      : r.authorUserId
        ? `${userNames.get(r.authorUserId) ?? "user"} (human)`
        : "system",
    createdAt: r.createdAt,
    body: r.body,
  }));

  let inserted: { id: string } | undefined;
  try {
    [inserted] = await db
      .insert(issueContextCompactions)
      .values({
        companyId: issue.companyId,
        issueId: issue.id,
        status: "queued",
        trigger: input.trigger,
        requestedByUserId: input.requestedByUserId ?? null,
        requestedByAgentId: input.requestedByAgentId ?? null,
        throughCommentId: through.id,
        throughCreatedAt: through.createdAt,
        previousCompactionId: previous?.id ?? null,
        sourceMessageCount: toSummarize.length,
        compactorAgentId: compactor.id,
      })
      .returning({ id: issueContextCompactions.id });
  } catch (error) {
    // The one-active-per-issue index lost a race with a concurrent request.
    const [raced] = await db
      .select({ id: issueContextCompactions.id })
      .from(issueContextCompactions)
      .where(and(eq(issueContextCompactions.issueId, issue.id), inArray(issueContextCompactions.status, ["queued", "running"])));
    if (raced) return { status: "already_running", compactionId: raced.id };
    throw error;
  }
  const compactionId = inserted!.id;

  const dir = compactionDir(issue.companyId, issue.id, compactionId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const transcript = renderTranscript({ issue, previousSummary: previous?.summaryMarkdown ?? null, messages });
  const transcriptPath = path.join(dir, "transcript.md");
  await writeFile(transcriptPath, transcript, { mode: 0o600 });
  const archive = gzipSync(Buffer.from(JSON.stringify({
    version: 1,
    compactionId,
    issue: { id: issue.id, identifier: issue.identifier, title: issue.title },
    previousCompactionId: previous?.id ?? null,
    previousSummary: previous?.summaryMarkdown ?? null,
    comments: toSummarize,
    archivedAt: new Date().toISOString(),
  })));
  const archivePath = path.join(dir, "archive.json.gz");
  await writeFile(archivePath, archive, { mode: 0o600 });

  const issueRef = issue.identifier ? `${issue.identifier} ("${issue.title}")` : `"${issue.title}"`;
  const prompt = compactionPrompt(transcriptPath, issueRef);
  const run = await wakeupRef(compactor.id, {
    source: "automation",
    triggerDetail: "system",
    reason: COMPACTION_WAKE_REASON,
    payload: { prompt },
    idempotencyKey: `compaction:${compactionId}`,
    requestedByActorType: "system",
    requestedByActorId: "context-compaction",
    contextSnapshot: {
      taskKey: `compaction:${compactionId}`,
      wakeReason: COMPACTION_WAKE_REASON,
      wakeSource: "automation",
      wakeTriggerDetail: "system",
      buCompactionId: compactionId,
      paperclipAgentMessage: { text: prompt, source: "context_compaction" },
    },
  }).catch((error: unknown) => {
    logger.warn({ err: error, compactionId }, "context compaction: could not start the compactor run");
    return null;
  });

  await db
    .update(issueContextCompactions)
    .set(run
      ? { status: "running", compactorRunId: run.id, archivePath, archiveSha256: createHash("sha256").update(archive).digest("hex"),
          sourceBytes: Buffer.byteLength(transcript), updatedAt: new Date() }
      : { status: "failed", error: "compactor run was not started", archivePath, updatedAt: new Date(), completedAt: new Date() })
    .where(eq(issueContextCompactions.id, compactionId));

  return run ? { status: "started", compactionId } : { status: "unavailable", reason: "compactor run was not started" };
}

function extractSummary(result: Record<string, unknown> | null): string | null {
  const raw = [result?.summary, result?.result].find((v): v is string => typeof v === "string" && v.trim().length > 0);
  if (!raw) return null;
  // Drop anything before the first heading, in case the model added a preamble.
  const text = raw.trim();
  const start = text.search(/^#{1,3}\s/m);
  const body = (start > 0 ? text.slice(start) : text).trim();
  return body.length > SUMMARY_MAX_CHARS ? `${body.slice(0, SUMMARY_MAX_CHARS - 20).trimEnd()}\n[truncated]` : body;
}

/** Finalizes the compaction whose compactor run just ended. Idempotent. */
export async function onCompactionRunTerminal(db: Db, runId: string, status: string): Promise<void> {
  const [row] = await db
    .select()
    .from(issueContextCompactions)
    .where(and(eq(issueContextCompactions.compactorRunId, runId), eq(issueContextCompactions.status, "running")));
  if (!row) return;
  const now = new Date();
  if (status !== "succeeded") {
    await db.update(issueContextCompactions)
      .set({ status: "failed", error: `compactor run ${status}`, updatedAt: now, completedAt: now })
      .where(and(eq(issueContextCompactions.id, row.id), eq(issueContextCompactions.status, "running")));
    return;
  }
  const [run] = await db.select({ result: heartbeatRuns.resultJson }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  const summary = extractSummary(run?.result ?? null);
  if (!summary || summary.length < 200 || /sk-ant-|ghp_|github_pat_/.test(summary)) {
    await db.update(issueContextCompactions)
      .set({ status: "failed", error: summary ? "summary rejected (too short or contains a secret pattern)" : "compactor returned no text", updatedAt: now, completedAt: now })
      .where(and(eq(issueContextCompactions.id, row.id), eq(issueContextCompactions.status, "running")));
    return;
  }
  const updated = await db.transaction(async (tx) => {
    const [done] = await tx.update(issueContextCompactions)
      .set({ status: "ready", summaryMarkdown: summary, summaryBytes: Buffer.byteLength(summary), updatedAt: now, completedAt: now })
      .where(and(eq(issueContextCompactions.id, row.id), eq(issueContextCompactions.status, "running")))
      .returning({ id: issueContextCompactions.id });
    if (!done) return false;
    await tx.update(issueContextCompactions)
      .set({ status: "superseded", updatedAt: now })
      .where(and(
        eq(issueContextCompactions.issueId, row.issueId),
        eq(issueContextCompactions.status, "ready"),
        sql`${issueContextCompactions.id} <> ${row.id}`,
      ));
    // The provider session still holds the long history; the next turn must start fresh from the summary.
    const [issue] = await tx.select().from(issues).where(eq(issues.id, row.issueId));
    const owner = issue?.assigneeAgentId ?? issue?.conversationAgentId ?? null;
    if (owner) {
      await tx.delete(agentTaskSessions).where(and(
        eq(agentTaskSessions.companyId, row.companyId),
        eq(agentTaskSessions.agentId, owner),
        eq(agentTaskSessions.taskKey, row.issueId),
      ));
    }
    return true;
  });
  if (updated) {
    await logActivity(db, {
      companyId: row.companyId,
      actorType: "system",
      actorId: "context-compaction",
      action: "issue.context_compacted",
      entityType: "issue",
      entityId: row.issueId,
      runId,
      details: { compactionId: row.id, messages: row.sourceMessageCount, sourceBytes: row.sourceBytes, summaryBytes: Buffer.byteLength(summary) },
    }).catch(() => undefined);
  }
}

/** Automatic trigger: the continuation outgrew the soft limit. Fire-and-forget. */
export function requestAutoCompaction(db: Db, companyId: string, issueId: string): void {
  void requestCompaction(db, { companyId, issueId, trigger: "auto" })
    .then((result) => {
      if (result.status === "started") logger.info({ issueId, compactionId: result.compactionId }, "context compaction: auto-started");
    })
    .catch((error: unknown) => logger.warn({ err: error, issueId }, "context compaction: auto request failed"));
}

export const COMPACTION_SUMMARY_KEY = "context-compaction";
export const COMPACTION_SUMMARY_MAX_CHARS = 16_000;

/**
 * Chats have no task continuation: their history lives in the provider
 * session, which a compaction drops. When a chat turn starts without a session
 * and a compaction is ready, hand the agent the summary plus the messages after
 * it, in the wake payload's continuation-summary slot.
 */
export async function conversationCompactionSummary(
  db: Db,
  companyId: string,
  issueId: string | null,
  agentId: string,
): Promise<{ key: string; title: string; body: string; sourceTrust: null; updatedAt: Date } | null> {
  if (!issueId) return null;
  const [compaction] = await db
    .select()
    .from(issueContextCompactions)
    .where(and(eq(issueContextCompactions.companyId, companyId), eq(issueContextCompactions.issueId, issueId), eq(issueContextCompactions.status, "ready")))
    .orderBy(desc(issueContextCompactions.completedAt))
    .limit(1);
  if (!compaction?.summaryMarkdown || !compaction.throughCreatedAt || !compaction.throughCommentId) return null;
  const [session] = await db
    .select({ id: agentTaskSessions.id })
    .from(agentTaskSessions)
    .where(and(eq(agentTaskSessions.companyId, companyId), eq(agentTaskSessions.agentId, agentId), eq(agentTaskSessions.taskKey, issueId)));
  if (session) return null; // the live session already carries the conversation
  const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
  // A /new after the compaction means the summary belongs to a forgotten session.
  if (issue?.conversationBoundaryCommentId) {
    const [boundary] = await db.select({ createdAt: issueComments.createdAt }).from(issueComments)
      .where(eq(issueComments.id, issue.conversationBoundaryCommentId));
    if (boundary && boundary.createdAt > compaction.throughCreatedAt) return null;
  }
  const recent = await db.select().from(issueComments).where(and(
    eq(issueComments.companyId, companyId),
    eq(issueComments.issueId, issueId),
    isNull(issueComments.deletedAt),
    sql`(${issueComments.createdAt}, ${issueComments.id}) > (${compaction.throughCreatedAt.toISOString()}::timestamptz, ${compaction.throughCommentId}::uuid)`,
  )).orderBy(asc(issueComments.createdAt), asc(issueComments.id));
  const recentText = recent
    .slice(-12)
    .map((c) => `### ${c.authorAgentId ? "You (agent)" : c.authorUserId ? "User" : "System"} · ${c.createdAt.toISOString()}\n\n${c.body.trim()}`)
    .join("\n\n");
  let body = `${compaction.summaryMarkdown.trim()}\n\n## Most recent messages (verbatim, oldest first)\n\n${recentText || "(none)"}`;
  if (body.length > COMPACTION_SUMMARY_MAX_CHARS) body = `${body.slice(0, COMPACTION_SUMMARY_MAX_CHARS - 20)}\n[truncated]`;
  return {
    key: COMPACTION_SUMMARY_KEY,
    title: "Summary of this conversation so far (the session was compacted)",
    body,
    sourceTrust: null,
    updatedAt: compaction.completedAt ?? compaction.updatedAt,
  };
}

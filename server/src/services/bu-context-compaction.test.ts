// bu-fork: context compaction, end to end against a real database.
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentTaskSessions,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueContextCompactions,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { conversationCompactionSummary, onCompactionRunTerminal, registerCompactionWakeup, requestCompaction } from "./bu-context-compaction.js";
import { buildExecutionContinuation } from "./execution-continuation.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("context compaction", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const workerId = randomUUID();
  const compactorId = randomUUID();
  const issueId = randomUUID();
  const commentIds = Array.from({ length: 10 }, () => randomUUID());
  const wakes: Array<{ agentId: string; context: Record<string, unknown>; runId: string }> = [];
  let previousHome: string | undefined;

  beforeAll(async () => {
    previousHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = await mkdtemp(path.join(os.tmpdir(), "bu-compaction-home-"));
    process.env.PAPERCLIP_BU_COMPACTION_AGENT = "Compactor";
    database = await startEmbeddedPostgresTestDatabase("paperclip-bu-compaction-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Compaction", issuePrefix: "CMP" });
    await db.insert(agents).values([
      { id: workerId, companyId, name: "Worker", role: "engineer", adapterType: "claude_local" },
      { id: compactorId, companyId, name: "Compactor", role: "engineer", adapterType: "claude_local" },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Long task", status: "in_progress", assigneeAgentId: workerId });
    await db.insert(issueComments).values(commentIds.map((id, i) => ({
      id,
      companyId,
      issueId,
      authorType: (i % 2 ? "agent" : "user") as "agent" | "user",
      authorUserId: i % 2 ? null : "local-board",
      authorAgentId: i % 2 ? workerId : null,
      body: `message ${i} ${"x".repeat(8000)}`,
      createdAt: new Date(Date.UTC(2026, 8, 20, 10, i)),
    })));
    await db.insert(agentTaskSessions).values({ companyId, agentId: workerId, adapterType: "claude_local", taskKey: issueId });
    registerCompactionWakeup(async (agentId, opts) => {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: opts.contextSnapshot });
      wakes.push({ agentId, context: opts.contextSnapshot, runId });
      return { id: runId };
    });
  }, 120_000);

  afterAll(async () => {
    delete process.env.PAPERCLIP_BU_COMPACTION_AGENT;
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    await database?.cleanup();
  });

  it("runs a separate compactor session, archives the history, and replays the summary", async () => {
    const started = await requestCompaction(db, { companyId, issueId, trigger: "manual", requestedByUserId: "local-board" });
    expect(started.status).toBe("started");
    expect(await requestCompaction(db, { companyId, issueId, trigger: "manual" })).toMatchObject({ status: "already_running" });

    // The compactor, not the task's agent, is woken, with its own session key and no issue.
    expect(wakes).toHaveLength(1);
    expect(wakes[0].agentId).toBe(compactorId);
    expect(wakes[0].context.issueId).toBeUndefined();
    expect(String(wakes[0].context.taskKey)).toMatch(/^compaction:/);

    const [row] = await db.select().from(issueContextCompactions).where(eq(issueContextCompactions.issueId, issueId));
    expect(row.status).toBe("running");
    expect(row.sourceMessageCount).toBe(6); // the 4 newest stay verbatim
    expect(row.throughCommentId).toBe(commentIds[5]);
    const archive = JSON.parse(gunzipSync(await readFile(row.archivePath!)).toString());
    expect(archive.comments).toHaveLength(6);

    const summary = `## Goal\nFinish the long task.\n\n## Current state\n${"Detail. ".repeat(40)}`.trim();
    await db.update(heartbeatRuns).set({ status: "succeeded", resultJson: { summary: `Here you go:\n${summary}` } })
      .where(eq(heartbeatRuns.id, wakes[0].runId));
    await onCompactionRunTerminal(db, wakes[0].runId, "succeeded");

    const [ready] = await db.select().from(issueContextCompactions).where(eq(issueContextCompactions.id, row.id));
    expect(ready.status).toBe("ready");
    expect(ready.summaryMarkdown).toBe(summary); // preamble stripped
    // The bloated provider session is dropped so the next turn starts from the summary.
    expect(await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.taskKey, issueId))).toHaveLength(0);

    const envelope = await buildExecutionContinuation({
      db, companyId, issueId, agentId: workerId, context: { issueId }, summary: null, exposeLowTrustRaw: true,
    });
    expect(envelope.coverage.kind).toBe("summarized_task_history");
    expect(envelope.summary?.markdown).toBe(summary);
    expect(envelope.messages.map((m) => m.id)).toEqual(commentIds.slice(6));

    // Only the 4 kept messages are newer than the cursor: nothing to do yet.
    expect(await requestCompaction(db, { companyId, issueId, trigger: "manual" })).toEqual({ status: "nothing_to_compact" });
    // Later messages chain a new compaction on top of the previous summary.
    await db.insert(issueComments).values(Array.from({ length: 3 }, (_, i) => ({
      companyId, issueId, authorType: "user" as const, authorUserId: "local-board", body: `later ${i}`,
      createdAt: new Date(Date.UTC(2026, 8, 20, 11, i)),
    })));
    const chained = await requestCompaction(db, { companyId, issueId, trigger: "auto" });
    expect(chained.status).toBe("started");
    const [second] = await db.select().from(issueContextCompactions)
      .where(eq(issueContextCompactions.id, (chained as { compactionId: string }).compactionId));
    expect(second.previousCompactionId).toBe(row.id);
    expect(second.sourceMessageCount).toBe(3); // 7 newer messages, 4 kept verbatim
    const transcript = await readFile(path.join(path.dirname(second.archivePath!), "transcript.md"), "utf8");
    expect(transcript).toContain("Finish the long task."); // previous summary carried forward
    await onCompactionRunTerminal(db, wakes.at(-1)!.runId, "cancelled");
  });

  it("hands a compacted chat its summary only while its session is fresh", async () => {
    const chatId = randomUUID();
    await db.insert(issues).values({
      id: chatId, companyId, title: "Chat with Worker", status: "in_review", assigneeAgentId: workerId,
      conversationAgentId: workerId, conversationUserId: "local-board", conversationState: "waiting",
    });
    await db.insert(issueComments).values(Array.from({ length: 8 }, (_, i) => ({
      companyId, issueId: chatId, authorType: "user" as const, authorUserId: "local-board", body: `chat ${i}`,
      createdAt: new Date(Date.UTC(2026, 8, 22, 10, i)),
    })));
    expect(await conversationCompactionSummary(db, companyId, chatId, workerId)).toBeNull();
    const started = await requestCompaction(db, { companyId, issueId: chatId, trigger: "chat_command" });
    expect(started.status).toBe("started");
    const runId = wakes.at(-1)!.runId;
    await db.update(heartbeatRuns).set({ status: "succeeded", resultJson: { summary: `## Goal\n${"Chat summary. ".repeat(30)}` } })
      .where(eq(heartbeatRuns.id, runId));
    await onCompactionRunTerminal(db, runId, "succeeded");

    const handoff = await conversationCompactionSummary(db, companyId, chatId, workerId);
    expect(handoff?.key).toBe("context-compaction");
    expect(handoff?.body).toContain("Chat summary.");
    expect(handoff?.body).toContain("chat 7"); // the recent messages come verbatim
    expect(handoff?.body).not.toContain("chat 0");

    await db.insert(agentTaskSessions).values({ companyId, agentId: workerId, adapterType: "claude_local", taskKey: chatId });
    expect(await conversationCompactionSummary(db, companyId, chatId, workerId)).toBeNull();
  });

  it("marks the compaction failed when the compactor run fails", async () => {
    const other = randomUUID();
    await db.insert(issues).values({ id: other, companyId, title: "Other", status: "in_progress", assigneeAgentId: workerId });
    await db.insert(issueComments).values(Array.from({ length: 6 }, (_, i) => ({
      companyId, issueId: other, authorType: "user" as const, authorUserId: "local-board", body: `m${i}`,
      createdAt: new Date(Date.UTC(2026, 8, 21, 10, i)),
    })));
    const started = await requestCompaction(db, { companyId, issueId: other, trigger: "auto" });
    expect(started.status).toBe("started");
    await onCompactionRunTerminal(db, wakes.at(-1)!.runId, "failed");
    const [row] = await db.select().from(issueContextCompactions).where(eq(issueContextCompactions.issueId, other));
    expect(row.status).toBe("failed");
  });
});

// bu-fork: context compaction (doc/bu/context-compaction-plan.md).
import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { issueContextCompactions, issues, type Db } from "@paperclipai/db";
import { forbidden, notFound } from "../errors.js";
import { requestCompaction } from "../services/bu-context-compaction.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function buCompactionRoutes(db: Db) {
  const router = Router();

  async function loadIssue(id: string) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, id));
    if (!issue) throw notFound("Issue not found");
    return issue;
  }

  /** Summarize this task's or chat's history in a separate run. Board members, or the assigned agent. */
  router.post("/issues/:id/compact", async (req, res) => {
    const issue = await loadIssue(req.params.id as string);
    assertCompanyAccess(req, issue.companyId);
    const actor = getActorInfo(req);
    if (actor.actorType === "agent" && actor.agentId !== issue.assigneeAgentId && actor.agentId !== issue.conversationAgentId) {
      throw forbidden("Only the assigned agent can compact this task");
    }
    const result = await requestCompaction(db, {
      companyId: issue.companyId,
      issueId: issue.id,
      trigger: "manual",
      requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
      requestedByAgentId: actor.actorType === "agent" ? actor.agentId : null,
    });
    res.status(result.status === "started" ? 202 : 200).json(result);
  });

  /** Compaction history, newest first, without the archive contents. */
  router.get("/issues/:id/compactions", async (req, res) => {
    const issue = await loadIssue(req.params.id as string);
    assertCompanyAccess(req, issue.companyId);
    const rows = await db
      .select({
        id: issueContextCompactions.id,
        status: issueContextCompactions.status,
        trigger: issueContextCompactions.trigger,
        throughCommentId: issueContextCompactions.throughCommentId,
        sourceMessageCount: issueContextCompactions.sourceMessageCount,
        sourceBytes: issueContextCompactions.sourceBytes,
        summaryBytes: issueContextCompactions.summaryBytes,
        summaryMarkdown: issueContextCompactions.summaryMarkdown,
        compactorAgentId: issueContextCompactions.compactorAgentId,
        compactorRunId: issueContextCompactions.compactorRunId,
        error: issueContextCompactions.error,
        createdAt: issueContextCompactions.createdAt,
        completedAt: issueContextCompactions.completedAt,
      })
      .from(issueContextCompactions)
      .where(and(eq(issueContextCompactions.companyId, issue.companyId), eq(issueContextCompactions.issueId, issue.id)))
      .orderBy(desc(issueContextCompactions.createdAt))
      .limit(50);
    res.json(rows);
  });

  return router;
}

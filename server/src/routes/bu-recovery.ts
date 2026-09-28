// bu-fork: "Automatic recovery stopped" has no UI action (doc/bu/TODO.md).
// Read-only diagnosis; the actual resolve still goes through Paperclip's own
// POST /issues/:id/recovery-actions/resolve (see bu-recovery-diagnosis.ts).
import { Router } from "express";
import { issues, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { notFound } from "../errors.js";
import { diagnoseRecoveryAction } from "../services/bu-recovery-diagnosis.js";
import { assertCompanyAccess } from "./authz.js";

export function buRecoveryRoutes(db: Db) {
  const router = Router();

  router.get("/issues/:id/recovery-actions/:actionId/diagnose", async (req, res) => {
    const [issue] = await db.select({ id: issues.id, companyId: issues.companyId }).from(issues).where(eq(issues.id, req.params.id as string));
    if (!issue) throw notFound("Issue not found");
    assertCompanyAccess(req, issue.companyId);
    const diagnosis = await diagnoseRecoveryAction(db, {
      companyId: issue.companyId,
      issueId: issue.id,
      actionId: req.params.actionId as string,
    });
    res.json(diagnosis);
  });

  return router;
}

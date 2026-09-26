// bu-fork: context compaction (doc/bu/context-compaction-plan.md).
import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issueComments } from "./issue_comments.js";
import { issues } from "./issues.js";

/**
 * One compaction of an issue's (task or chat) history: a summary produced by a
 * separate clean agent run, covering every comment up to `throughCommentId`,
 * plus a gzip archive of the exact pre-compaction continuation.
 */
export const issueContextCompactions = pgTable(
  "issue_context_compactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    /** queued → running → ready | failed | superseded */
    status: text("status").notNull().default("queued"),
    /** manual | auto | chat_command */
    trigger: text("trigger").notNull(),
    requestedByUserId: text("requested_by_user_id"),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    throughCommentId: uuid("through_comment_id").references(() => issueComments.id, { onDelete: "set null" }),
    throughCreatedAt: timestamp("through_created_at", { withTimezone: true }),
    previousCompactionId: uuid("previous_compaction_id"),
    summaryMarkdown: text("summary_markdown"),
    sourceMessageCount: integer("source_message_count").notNull().default(0),
    sourceBytes: integer("source_bytes").notNull().default(0),
    summaryBytes: integer("summary_bytes"),
    archivePath: text("archive_path"),
    archiveSha256: text("archive_sha256"),
    compactorAgentId: uuid("compactor_agent_id").references(() => agents.id, { onDelete: "set null" }),
    compactorRunId: uuid("compactor_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    companyIssueStatusIdx: index("issue_context_compactions_company_issue_status_idx").on(
      table.companyId,
      table.issueId,
      table.status,
    ),
    compactorRunIdx: index("issue_context_compactions_compactor_run_idx").on(table.compactorRunId),
    // At most one compaction in flight per issue.
    oneActivePerIssue: uniqueIndex("issue_context_compactions_one_active_per_issue")
      .on(table.issueId)
      .where(sql`${table.status} in ('queued', 'running')`),
  }),
);

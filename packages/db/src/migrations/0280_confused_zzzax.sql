CREATE TABLE "issue_context_compactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger" text NOT NULL,
	"requested_by_user_id" text,
	"requested_by_agent_id" uuid,
	"through_comment_id" uuid,
	"through_created_at" timestamp with time zone,
	"previous_compaction_id" uuid,
	"summary_markdown" text,
	"source_message_count" integer DEFAULT 0 NOT NULL,
	"source_bytes" integer DEFAULT 0 NOT NULL,
	"summary_bytes" integer,
	"archive_path" text,
	"archive_sha256" text,
	"compactor_agent_id" uuid,
	"compactor_run_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "issue_context_compactions" ADD CONSTRAINT "issue_context_compactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_context_compactions" ADD CONSTRAINT "issue_context_compactions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_context_compactions" ADD CONSTRAINT "issue_context_compactions_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_context_compactions" ADD CONSTRAINT "issue_context_compactions_through_comment_id_issue_comments_id_fk" FOREIGN KEY ("through_comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_context_compactions" ADD CONSTRAINT "issue_context_compactions_compactor_agent_id_agents_id_fk" FOREIGN KEY ("compactor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_context_compactions" ADD CONSTRAINT "issue_context_compactions_compactor_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("compactor_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_context_compactions_company_issue_status_idx" ON "issue_context_compactions" USING btree ("company_id","issue_id","status");--> statement-breakpoint
CREATE INDEX "issue_context_compactions_compactor_run_idx" ON "issue_context_compactions" USING btree ("compactor_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_context_compactions_one_active_per_issue" ON "issue_context_compactions" USING btree ("issue_id") WHERE "issue_context_compactions"."status" in ('queued', 'running');
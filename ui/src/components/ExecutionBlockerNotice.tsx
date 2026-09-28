import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ExecutionBlocker } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { activityApi } from "../api/activity";
import { buRecoveryApi } from "../api/bu-recovery"; // bu-fork
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";

export function ExecutionBlockerNotice({ companyId, issueId, blocker, onRetried }: {
  companyId: string;
  issueId: string;
  blocker: ExecutionBlocker;
  onRetried: () => void;
}) {
  const queryClient = useQueryClient();
  const [resumeMessage, setResumeMessage] = useState<string | null>(null);
  const { data: runs } = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
  });
  const failedRun = runs?.find(run => run.runId === blocker.runId &&
    ["failed", "timed_out"].includes(run.status));
  const invalidateAfterRecovery = () => {
    onRetried();
    for (const queryKey of [queryKeys.issues.detail(issueId), queryKeys.issues.runs(issueId),
      queryKeys.issues.liveRuns(issueId), queryKeys.issues.activeRun(issueId)]) {
      void queryClient.invalidateQueries({ queryKey });
    }
  };
  const retry = useMutation({
    mutationFn: () => agentsApi.retryFailedRun(failedRun!.agentId, failedRun!.runId, companyId),
    onSuccess: invalidateAfterRecovery,
  });
  // bu-fork: "Automatic recovery stopped" — diagnose, then resolve if provably safe.
  const resume = useMutation({
    mutationFn: async () => {
      setResumeMessage(null);
      const diagnosis = await buRecoveryApi.diagnose(issueId, blocker.recoveryActionId!);
      if (!diagnosis.safe || !diagnosis.reconciliation) {
        setResumeMessage(diagnosis.reason);
        return false;
      }
      await buRecoveryApi.resolve(issueId, diagnosis.reconciliation);
      return true;
    },
    onSuccess: (resolved) => {
      if (resolved) invalidateAfterRecovery();
    },
  });
  // bu-fork: server-side diagnose call is the real gate; recoveryActionId
  // just means "there's something to potentially auto-clear".
  const canResume = Boolean(blocker.recoveryActionId);
  return (
    <div role="status" aria-label="Task recovery" className="mx-(--sz-execution-blocker-inline) my-(--sz-execution-blocker-block) flex flex-wrap items-center justify-between execution-blocker-notice border border-border bg-muted text-foreground">
      <span>{blocker.cause === "legacy_execution_requires_reconciliation" ? "Automatic recovery of this task stopped." : blocker.nextAction}</span>
      {canResume && (
        <Button
          variant="outline"
          size="sm"
          disabled={resume.isPending}
          title="Check whether the stopped run made any change, and resume automatically if it didn't."
          onClick={() => resume.mutate()}
        >
          {resume.isPending ? "Checking…" : "Resume"}
        </Button>
      )}
      {failedRun && (
        <Button variant="outline" size="sm" disabled={retry.isPending} onClick={() => retry.mutate()}>
          {retry.isPending ? "Retrying…" : "Retry"}
        </Button>
      )}
      {resumeMessage && (
        <p role="status" className="w-full text-muted-foreground">{resumeMessage}</p>
      )}
      {resume.isError && (
        <p role="alert" className="w-full text-destructive">{resume.error.message}</p>
      )}
      {retry.isError && (
        <p role="alert" className="w-full text-destructive">{retry.error.message}</p>
      )}
    </div>
  );
}

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExecutionBlockerNotice } from "./ExecutionBlockerNotice";
import { agentsApi } from "../api/agents";
import { activityApi } from "../api/activity";
import { buRecoveryApi } from "../api/bu-recovery"; // bu-fork
vi.mock("../api/agents", () => ({ agentsApi: { retryFailedRun: vi.fn() } }));
vi.mock("../api/activity", () => ({ activityApi: { runsForIssue: vi.fn() } }));
// bu-fork: the Resume button's own two calls, mocked separately from Retry's.
vi.mock("../api/bu-recovery", () => ({ buRecoveryApi: { diagnose: vi.fn(), resolve: vi.fn() } }));

function byText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === text);
  if (!button) throw new Error(`No button with text "${text}"`);
  return button;
}

describe("stopped task recovery notice", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  const onRetried = vi.fn();
  beforeEach(async () => {
    vi.clearAllMocks();
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.mocked(activityApi.runsForIssue).mockResolvedValue([{ runId: "failed-run", agentId: "agent", status: "failed" }] as never);
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "failed-run", agentId: "agent", cause: "legacy_execution_requires_reconciliation",
        nextAction: "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated.",
      }} />
    </QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  it("shows the requested sentence, Resume and Retry, inside a distinct recovery container", () => {
    const notice = container.querySelector('[role="status"][aria-label="Task recovery"]')!;
    expect(notice.textContent).toBe("Automatic recovery of this task stopped.ResumeRetry");
    expect(notice.classList.contains("border")).toBe(true);
    expect(notice.classList.contains("bg-muted")).toBe(true);
    expect(notice.querySelector("a")).toBeNull();
  });
  it("keeps the required next action for other reconciliation causes, and still offers Resume", async () => {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "failed-run", agentId: "agent", cause: "action_outcome_unknown",
        nextAction: "Verify the external action outcome before continuing.",
      }} />
    </QueryClientProvider>));
    expect(container.textContent).toContain("Verify the external action outcome before continuing.");
    expect(container.textContent).not.toContain("Automatic recovery of this task stopped.");
    expect(container.textContent).toContain("Resume");
  });
  it("has no Resume button when the blocker carries no recovery action", async () => {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried} blocker={{
        recoveryActionId: null, runId: "failed-run", agentId: "agent", cause: "provider_ownership_unverified",
        nextAction: "Live execution authority blocks continuation.",
      }} />
    </QueryClientProvider>));
    expect(container.textContent).not.toContain("Resume");
  });
  it("retries the exact failed run and refreshes the task", async () => {
    vi.mocked(agentsApi.retryFailedRun).mockResolvedValue({} as never);
    await act(async () => byText(container, "Retry").click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(agentsApi.retryFailedRun).toHaveBeenCalledWith("agent", "failed-run", "company");
    expect(onRetried).toHaveBeenCalledOnce();
  });
  it("shows a failed Retry in the same container and allows another attempt", async () => {
    vi.mocked(agentsApi.retryFailedRun).mockRejectedValue(new Error("Environment cleanup is still running."));
    await act(async () => byText(container, "Retry").click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Environment cleanup is still running.");
    expect(byText(container, "Retry").disabled).toBe(false);
    expect(onRetried).not.toHaveBeenCalled();
  });
  // bu-fork: Resume (diagnose, then resolve if safe).
  it("Resume: when the diagnosis is safe, resolves and refreshes without asking again", async () => {
    vi.mocked(buRecoveryApi.diagnose).mockResolvedValue({
      safe: true, reason: "clean",
      reconciliation: {
        actionId: "recovery", outcome: "restored", sourceIssueStatus: "todo", resolutionNote: "note",
        executionReconciliation: { runId: "failed-run", providerStopped: true, actionOutcome: "not_performed", outcomeEvidence: "note" },
      },
    });
    vi.mocked(buRecoveryApi.resolve).mockResolvedValue({ issue: { status: "todo" } } as never);
    await act(async () => byText(container, "Resume").click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(buRecoveryApi.diagnose).toHaveBeenCalledWith("task", "recovery");
    expect(buRecoveryApi.resolve).toHaveBeenCalledWith("task", expect.objectContaining({ actionId: "recovery" }));
    expect(onRetried).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  it("Resume: when the diagnosis is unsafe, shows the reason and never calls resolve", async () => {
    vi.mocked(buRecoveryApi.diagnose).mockResolvedValue({ safe: false, reason: "the workspace has uncommitted changes" });
    await act(async () => byText(container, "Resume").click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(buRecoveryApi.resolve).not.toHaveBeenCalled();
    expect(onRetried).not.toHaveBeenCalled();
    expect(container.textContent).toContain("the workspace has uncommitted changes");
  });
});

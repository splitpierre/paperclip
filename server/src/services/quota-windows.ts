import type { ProviderQuotaResult } from "@paperclipai/shared";
import { listServerAdapters } from "../adapters/registry.js";

const QUOTA_PROVIDER_TIMEOUT_MS = 20_000;

function providerSlugForAdapterType(type: string): string {
  switch (type) {
    case "claude_local":
      return "anthropic";
    case "codex_local":
      return "openai";
    default:
      return type;
  }
}

export interface CachedQuotaWindows {
  asOf: string;
  results: ProviderQuotaResult[];
}

// bu-fork: in-memory cache for the agent-readable /quota-windows/cached route.
// fetchAllQuotaWindows() below is genuinely expensive (spawns `claude`/`codex`
// subprocesses and/or hits live provider usage APIs, up to QUOTA_PROVIDER_TIMEOUT_MS
// per adapter), which is why it's kept board-only in routes/costs.ts. This cache lets
// Ária (and other agents) check quota before delegating without paying that cost on
// every heartbeat. Refreshed on a timer from server/src/app.ts, not lazily on read.
let quotaWindowsCache: CachedQuotaWindows | null = null;

/** Refreshes the in-memory quota-windows cache from live providers. Safe to call on a timer. */
export async function refreshQuotaWindowsCache(): Promise<CachedQuotaWindows> {
  const results = await fetchAllQuotaWindows();
  quotaWindowsCache = { asOf: new Date().toISOString(), results };
  return quotaWindowsCache;
}

/**
 * Returns the last cached quota snapshot with no live provider calls — cheap enough to
 * expose to agent callers. Returns null only before the first refresh has ever
 * completed (e.g. immediately after server startup, for at most one refresh interval).
 */
export function getCachedQuotaWindows(): CachedQuotaWindows | null {
  return quotaWindowsCache;
}

/**
 * Asks each registered adapter for its provider quota windows and aggregates the results.
 * Adapters that don't implement getQuotaWindows() are silently skipped.
 * Individual adapter failures are caught and returned as error results rather than
 * letting one provider's outage block the entire response.
 */
export async function fetchAllQuotaWindows(): Promise<ProviderQuotaResult[]> {
  const adapters = listServerAdapters().filter((a) => a.getQuotaWindows != null);

  const settled = await Promise.allSettled(
    adapters.map((adapter) => withQuotaTimeout(adapter.type, adapter.getQuotaWindows!())),
  );

  return settled.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    const adapterType = adapters[i]!.type;
    return {
      provider: providerSlugForAdapterType(adapterType),
      ok: false,
      error: String(result.reason),
      windows: [],
    };
  });
}

async function withQuotaTimeout(
  adapterType: string,
  task: Promise<ProviderQuotaResult>,
): Promise<ProviderQuotaResult> {
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<ProviderQuotaResult>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({
            provider: providerSlugForAdapterType(adapterType),
            ok: false,
            error: `quota polling timed out after ${Math.round(QUOTA_PROVIDER_TIMEOUT_MS / 1000)}s`,
            windows: [],
          });
        }, QUOTA_PROVIDER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

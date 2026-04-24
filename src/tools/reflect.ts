import type { ContextEntry } from "../types.js";
import type { StoreEnv } from "./store.js";
import { getSessionHistory } from "./store.js";

const REFLECTION_MAX_WORDS = 100;

function truncateToWords(text: string, max: number): string {
  const words = text.split(/\s+/);
  if (words.length <= max) return text;
  return words.slice(0, max).join(" ") + "…";
}

function buildNarrative(entries: ContextEntry[], prompt?: string): string {
  if (entries.length === 0) return "No session history found.";

  const byType: Record<string, number> = {};
  const recentSummaries: string[] = [];

  for (const e of entries) {
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    if (recentSummaries.length < 5) {
      recentSummaries.push(`[${e.type}] ${e.summary}`);
    }
  }

  const typeBreakdown = Object.entries(byType)
    .map(([t, n]) => `${n} ${t}(s)`)
    .join(", ");

  const first = entries[0];
  const last = entries[entries.length - 1];
  const durationMs = (last?.created_at ?? 0) - (first?.created_at ?? 0);
  const durationMin = Math.round(durationMs / 60_000);

  const narrative = [
    `Session has ${entries.length} entries (${typeBreakdown}) over ~${durationMin} min.`,
    `Recent: ${recentSummaries.join(" | ")}`,
    prompt ? `Focus: ${prompt}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return truncateToWords(narrative, REFLECTION_MAX_WORDS);
}

export async function ctxReflect(
  env: StoreEnv,
  sessionId: string,
  prompt?: string
): Promise<string> {
  const entries = await getSessionHistory(env, sessionId, 50);
  return buildNarrative(entries, prompt);
}

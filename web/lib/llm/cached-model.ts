/**
 * Eval-time model wrapper: disk cache keyed by the full request, a hard cap on provider calls
 * (checked before sending, so a bug cannot overspend), and token accounting. Only clean
 * "stop" results are cached; truncated or failed generations are always refetched.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { wrapLanguageModel, type LanguageModel } from "ai";

export class CallCapError extends Error {}

export interface CallStats {
  calls: number;
  hits: number;
  inputTokens: number;
  outputTokens: number;
}

type Wrappable = Parameters<typeof wrapLanguageModel>[0]["model"];

export function cachedModel(
  model: Wrappable,
  { dir, version, maxCalls }: { dir: string; version: string; maxCalls: number },
): { model: LanguageModel; stats: CallStats } {
  mkdirSync(dir, { recursive: true });
  const stats: CallStats = { calls: 0, hits: 0, inputTokens: 0, outputTokens: 0 };
  const wrapped = wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ doGenerate, params, model: inner }) => {
        // abortSignal/headers are per-call plumbing, not part of what is being asked.
        const { abortSignal: _signal, headers: _headers, ...request } = params;
        void _signal;
        void _headers;
        const key = createHash("sha256")
          .update(JSON.stringify([version, inner.provider, inner.modelId, request]))
          .digest("hex");
        const file = path.join(dir, `${key}.json`);
        if (existsSync(file)) {
          stats.hits += 1;
          return JSON.parse(readFileSync(file, "utf8"));
        }
        if (stats.calls >= maxCalls) throw new CallCapError(`call cap ${maxCalls} reached; request not sent`);
        stats.calls += 1;
        const result = await doGenerate();
        stats.inputTokens += result.usage.inputTokens.total ?? 0;
        stats.outputTokens += result.usage.outputTokens.total ?? 0;
        if (result.finishReason.unified === "stop") {
          const { content, finishReason, usage, providerMetadata, warnings } = result;
          const tmp = `${file}.tmp`;
          writeFileSync(tmp, JSON.stringify({ content, finishReason, usage, providerMetadata, warnings }));
          renameSync(tmp, file); // atomic: a crash never leaves a half-written entry
        }
        return result;
      },
    },
  });
  return { model: wrapped, stats };
}

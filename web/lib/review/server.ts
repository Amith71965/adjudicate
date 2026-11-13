/**
 * Server-side wiring for the review UI: the committed cases (loaded once per process) and the
 * review-log client. Configuration follows the examiner service: ADJUDICATE_ROOT (repo root)
 * and ADJUDICATE_API (the FastAPI service, `make api`).
 */
import path from "node:path";
import { loadCases, type Case } from "./cases";
import { httpReviewStore, type DecisionStore, type ReviewStore } from "./store";

export const REVIEWER_COOKIE = "adjudicate_reviewer";

let cases: Case[] | undefined;

export function allCases(): Case[] {
  cases ??= loadCases(process.env.ADJUDICATE_ROOT ?? path.resolve(process.cwd(), ".."));
  return cases;
}

export const getCase = (id: string): Case | undefined => allCases().find((c) => c.id === id);

export const reviewStore = (): ReviewStore & DecisionStore => httpReviewStore(process.env.ADJUDICATE_API ?? "http://127.0.0.1:8000");

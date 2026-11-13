/** GET /api/decisions/[id]/locate?q=…: the page of the decision that holds a cited quote. */
import { reviewStore } from "@/lib/review/server";
import { makeLocateHandler } from "@/lib/review/viewer-routes";

export async function GET(req: Request, ctx: RouteContext<"/api/decisions/[id]/locate">): Promise<Response> {
  const { id } = await ctx.params;
  return makeLocateHandler(reviewStore())(id, new URL(req.url).searchParams.get("q") ?? "");
}

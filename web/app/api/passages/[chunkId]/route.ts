/** GET /api/passages/[chunkId]: a cited AAO passage, for the hover preview. */
import { reviewStore } from "@/lib/review/server";
import { makePassageHandler } from "@/lib/review/viewer-routes";

export async function GET(_req: Request, ctx: RouteContext<"/api/passages/[chunkId]">): Promise<Response> {
  const { chunkId } = await ctx.params;
  return makePassageHandler(reviewStore())(chunkId);
}

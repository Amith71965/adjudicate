/** GET /api/decisions/[id]/pdf: the stored AAO decision PDF, for the in-app viewer. */
import { reviewStore } from "@/lib/review/server";
import { makePdfHandler } from "@/lib/review/viewer-routes";

export async function GET(_req: Request, ctx: RouteContext<"/api/decisions/[id]/pdf">): Promise<Response> {
  const { id } = await ctx.params;
  return makePdfHandler(reviewStore())(id);
}

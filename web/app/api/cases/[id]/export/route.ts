/** GET /api/cases/[id]/export — the review memo, only past the gate (409 otherwise). */
import { makeExportHandler } from "@/lib/review/export";
import { getCase, reviewStore } from "@/lib/review/server";

export async function GET(_req: Request, ctx: RouteContext<"/api/cases/[id]/export">): Promise<Response> {
  const { id } = await ctx.params;
  return makeExportHandler({ getCase, store: reviewStore() })(id);
}

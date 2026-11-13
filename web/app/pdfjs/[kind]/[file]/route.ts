/** GET /pdfjs/[kind]/[file]: PDF.js runtime assets (decoders, fonts, cmaps) from the installed package. */
import path from "node:path";
import { makeAssetHandler } from "@/lib/review/pdfjs-assets";

const handler = makeAssetHandler(path.join(process.cwd(), "node_modules", "pdfjs-dist"));

export async function GET(_req: Request, ctx: RouteContext<"/pdfjs/[kind]/[file]">): Promise<Response> {
  const { kind, file } = await ctx.params;
  return handler(kind, file);
}

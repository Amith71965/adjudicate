/**
 * Serves PDF.js runtime assets from the installed pdfjs-dist package (no copies in the repo).
 * Only four folders and plain file names are allowed, so nothing else on disk is reachable.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const KINDS = new Set(["wasm", "standard_fonts", "cmaps", "iccs"]);
const FILE = /^[A-Za-z0-9_.-]+$/;
const TYPES: Record<string, string> = {
  ".wasm": "application/wasm",
  ".js": "text/javascript; charset=utf-8",
  ".pfb": "application/octet-stream",
  ".ttf": "font/ttf",
  ".bcmap": "application/octet-stream",
  ".icc": "application/vnd.iccprofile",
};

const notFound = () => new Response("not found", { status: 404 });

export function makeAssetHandler(packageRoot: string) {
  return async (kind: string, file: string): Promise<Response> => {
    if (!KINDS.has(kind) || !FILE.test(file) || file.startsWith(".")) return notFound();
    const type = TYPES[path.extname(file)];
    if (!type) return notFound();
    try {
      const bytes = await readFile(path.join(packageRoot, kind, file));
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable" },
      });
    } catch {
      return notFound();
    }
  };
}

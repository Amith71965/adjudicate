/**
 * PDF.js runtime assets (WebAssembly image decoders, standard fonts, character maps, colour
 * profiles) served from the installed package. Scanned AAO decisions use JBIG2 images, which
 * PDF.js 6 decodes in WebAssembly; without these the page renders blank. Only the four known
 * folders and plain file names are served: nothing else on disk is reachable.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeAssetHandler } from "@/lib/review/pdfjs-assets";

const handler = makeAssetHandler(path.resolve(__dirname, "../node_modules/pdfjs-dist"));

describe("pdf.js asset route", () => {
  it("serves the JBIG2 WebAssembly decoder", async () => {
    const res = await handler("wasm", "jbig2.wasm");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/wasm");
    expect(new Uint8Array(await res.arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([0x00, 0x61, 0x73, 0x6d])); // \0asm
  });

  it("serves the decoder's JavaScript fallback and the standard fonts", async () => {
    expect((await handler("wasm", "jbig2_nowasm_fallback.js")).headers.get("content-type")).toMatch(/javascript/);
    expect((await handler("standard_fonts", "FoxitSerif.pfb")).status).toBe(200);
  });

  it.each([
    ["wasm", "../package.json"],
    ["wasm", "..%2Fpackage.json"],
    ["build", "pdf.mjs"],
    ["../../app", "page.tsx"],
    ["wasm", "missing.wasm"],
  ])("refuses %s/%s", async (kind, file) => {
    expect((await handler(kind, file)).status).toBe(404);
  });
});

"use client";
/**
 * The AAO decision itself, rendered with PDF.js: opens on the page that holds the cited quote
 * and highlights exactly the words that match (lib/review/pdf-highlight). Page and zoom controls;
 * a text layer so the decision can be selected and searched like the original.
 */
import { ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { quoteItems } from "@/lib/review/pdf-highlight";

type Pdfjs = typeof import("pdfjs-dist");
type Doc = Awaited<ReturnType<Pdfjs["getDocument"]>["promise"]>;

let pdfjsPromise: Promise<Pdfjs> | null = null;
function pdfjs(): Promise<Pdfjs> {
  pdfjsPromise ??= import("pdfjs-dist").then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    return lib;
  });
  return pdfjsPromise;
}

export function PdfViewer({ src, quote, quotePage }: { src: string; quote: string; quotePage: number | null }) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(quotePage ?? 1);
  const [zoom, setZoom] = useState(1);
  const [hits, setHits] = useState<number | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    pdfjs()
      .then((lib) => lib.getDocument({
        url: src,
        // scanned decisions use JBIG2/JPX images, decoded by PDF.js in WebAssembly
        wasmUrl: "/pdfjs/wasm/",
        standardFontDataUrl: "/pdfjs/standard_fonts/",
        cMapUrl: "/pdfjs/cmaps/",
        cMapPacked: true,
        iccUrl: "/pdfjs/iccs/",
      }).promise)
      .then((d) => { if (!cancelled) setDoc(d); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [src]);

  useEffect(() => {
    if (!doc || !canvas.current || !text.current || !frame.current) return;
    let cancelled = false;
    const run = async () => {
      const lib = await pdfjs();
      const p = await doc.getPage(page);
      const fit = (frame.current!.clientWidth - 2) / p.getViewport({ scale: 1 }).width;
      const viewport = p.getViewport({ scale: fit * zoom });
      const ratio = window.devicePixelRatio || 1;
      const c = canvas.current!;
      c.width = Math.floor(viewport.width * ratio);
      c.height = Math.floor(viewport.height * ratio);
      c.style.width = `${Math.floor(viewport.width)}px`;
      c.style.height = `${Math.floor(viewport.height)}px`;
      await p.render({ canvas: c, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined }).promise;
      if (cancelled) return;
      const layer = text.current!;
      layer.replaceChildren();
      layer.parentElement!.style.setProperty("--scale-factor", String(viewport.scale));
      layer.parentElement!.style.setProperty("--total-scale-factor", String(viewport.scale));
      const tl = new lib.TextLayer({ textContentSource: await p.getTextContent(), container: layer, viewport });
      await tl.render();
      if (cancelled) return;
      const found = page === quotePage ? quoteItems(tl.textContentItemsStr, quote) : [];
      found.forEach((i) => tl.textDivs[i]?.classList.add("adj-hit"));
      setHits(page === quotePage ? found.length : null);
      tl.textDivs[found[0]]?.scrollIntoView({ block: "center", behavior: "smooth" });
    };
    run().catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [doc, page, zoom, quote, quotePage]);

  const total = doc?.numPages ?? 0;
  const btn = "inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--line-strong)] hover:bg-[var(--card)] disabled:opacity-40";

  if (error) {
    return <p role="alert" className="rounded-lg border border-[var(--red)] p-4 text-sm text-[var(--red)]">The decision could not be displayed ({error}). Use the USCIS link above.</p>;
  }
  return (
    <div>
      <div className="sticky top-14 z-10 flex flex-wrap items-center gap-2 border-b border-[var(--line)] bg-[color-mix(in_srgb,var(--paper)_88%,transparent)] py-2 backdrop-blur-md">
        <button type="button" className={btn} onClick={() => setPage((n) => Math.max(1, n - 1))} disabled={page <= 1} aria-label="Previous page"><ChevronLeft aria-hidden="true" width={16} height={16} /></button>
        <span className="font-mono text-xs" aria-live="polite">page {page} of {total || "…"}</span>
        <button type="button" className={btn} onClick={() => setPage((n) => Math.min(total, n + 1))} disabled={!total || page >= total} aria-label="Next page"><ChevronRight aria-hidden="true" width={16} height={16} /></button>
        <span className="mx-2 h-5 w-px bg-[var(--line)]" aria-hidden="true" />
        <button type="button" className={btn} onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.2).toFixed(1)))} aria-label="Zoom out"><Minus aria-hidden="true" width={16} height={16} /></button>
        <span className="w-12 text-center font-mono text-xs">{Math.round(zoom * 100)}%</span>
        <button type="button" className={btn} onClick={() => setZoom((z) => Math.min(2.4, +(z + 0.2).toFixed(1)))} aria-label="Zoom in"><Plus aria-hidden="true" width={16} height={16} /></button>
        {quotePage !== null && page !== quotePage && (
          <button type="button" onClick={() => setPage(quotePage)} className="ml-auto rounded-lg bg-[var(--ink)] px-3 py-1.5 text-xs text-[var(--paper)]">Back to the quote (page {quotePage})</button>
        )}
        {hits !== null && (
          <span data-testid="quote-status" className={`ml-auto font-mono text-xs ${hits ? "text-[var(--green)]" : "text-[var(--amber)]"}`}>
            {hits ? "quote highlighted" : "quote is on this page; exact words not matched"}
          </span>
        )}
      </div>
      <div ref={frame} className="mt-4 overflow-x-auto">
        <div className="pdf-page relative mx-auto w-fit overflow-hidden rounded-lg border border-[var(--line)] bg-white shadow-[var(--shadow-2)]" style={{ ["--user-unit" as string]: 1, ["--scale-round-x" as string]: "1px", ["--scale-round-y" as string]: "1px" }}>
          <canvas ref={canvas} aria-label={`Decision page ${page}`} role="img" />
          <div ref={text} className="textLayer" />
        </div>
      </div>
    </div>
  );
}

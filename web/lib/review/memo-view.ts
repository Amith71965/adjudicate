/**
 * The review memo (lib/review/export.ts writes simple Markdown) as plain blocks for the preview.
 * Only the shapes the memo uses: #, ##, "- " lists, paragraphs, and a **bold** lead. Text is
 * kept as text and rendered by React, so nothing in a note can become markup.
 */
export type MemoPart = { text: string; bold?: boolean };
export type MemoBlock =
  | { kind: "h1" | "h2"; text: string }
  | { kind: "p"; parts: MemoPart[] }
  | { kind: "ul"; items: string[] };

function parts(line: string): MemoPart[] {
  const out: MemoPart[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  for (const m of line.matchAll(re)) {
    if (m.index! > last) out.push({ text: line.slice(last, m.index) });
    out.push({ text: m[1], bold: true });
    last = m.index! + m[0].length;
  }
  if (last < line.length) out.push({ text: line.slice(last) });
  return out;
}

export function memoBlocks(memo: string): MemoBlock[] {
  const blocks: MemoBlock[] = [];
  for (const line of memo.split("\n")) {
    if (!line.trim()) continue;
    if (line.startsWith("# ")) blocks.push({ kind: "h1", text: line.slice(2) });
    else if (line.startsWith("## ")) blocks.push({ kind: "h2", text: line.slice(3) });
    else if (line.startsWith("- ")) {
      const prev = blocks.at(-1);
      if (prev?.kind === "ul") prev.items.push(line.slice(2));
      else blocks.push({ kind: "ul", items: [line.slice(2)] });
    } else blocks.push({ kind: "p", parts: parts(line) });
  }
  return blocks;
}

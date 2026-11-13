"use client";
/**
 * ⌘K / Ctrl+K: jump to any case or any objection by typing a few words in any order
 * ("judging marrow"). Arrow keys move, Enter goes, Escape closes.
 */
import { CornerDownLeft, FileText, Search, ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";

export interface PaletteEntry { href: string; title: string; hint: string; kind: "case" | "item" }

const LIMIT = 12;

export function Palette({ entries, navigate }: { entries: PaletteEntry[]; navigate: (href: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        setQuery("");
        setActive(0);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const results = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return entries.filter((e) => {
      const hay = `${e.title} ${e.hint}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    }).slice(0, LIMIT);
  }, [entries, query]);

  const go = (entry: PaletteEntry | undefined) => {
    if (!entry) return;
    setOpen(false);
    navigate(entry.href);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => { setOpen(true); setQuery(""); setActive(0); }}
        className="hidden items-center gap-2 rounded-lg border border-[var(--line)] px-2.5 py-1.5 text-xs text-[var(--muted)] hover:text-[var(--ink)] sm:inline-flex"
      >
        <Search aria-hidden="true" width={14} height={14} />Jump to…
        <kbd className="rounded border border-[var(--line-strong)] px-1 font-mono text-[10px]">⌘K</kbd>
      </button>
      {/* portalled: the app bar's backdrop-filter would otherwise contain this fixed overlay */}
      {open && createPortal(
        <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/30 p-4 pt-[12vh]" onClick={() => setOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label="Jump to a case or objection" onClick={(e) => e.stopPropagation()} className="pop-in w-full max-w-xl overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--raised)] shadow-[var(--shadow-2)]">
            <div className="flex items-center gap-2 border-b-2 border-[var(--line)] px-4 transition-colors focus-within:border-[var(--accent)]">
              <Search aria-hidden="true" width={16} height={16} className="text-[var(--muted)]" />
              <input
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
                aria-label="Search cases and objections"
                autoFocus
                value={query}
                placeholder="Case, beneficiary, criterion…"
                onChange={(e) => { setQuery(e.target.value); setActive(0); }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(results.length - 1, a + 1)); }
                  else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
                  else if (e.key === "Enter") { e.preventDefault(); go(results[active]); }
                  else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
                }}
                style={{ outline: "none" }} // the row's accent underline is the focus cue
                className="h-12 flex-1 bg-transparent text-sm"
              />
            </div>
            {results.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-[var(--muted)]">No case or objection matches “{query}”.</p>
            ) : (
              <ul id={listId} role="listbox" className="max-h-[50vh] overflow-y-auto p-2">
                {results.map((r, i) => (
                  <li
                    key={r.href}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(r)}
                    className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm ${i === active ? "bg-[var(--accent-soft)] text-[var(--ink)]" : "text-[var(--muted)]"}`}
                  >
                    {r.kind === "case" ? <FileText aria-hidden="true" width={15} height={15} /> : <ShieldAlert aria-hidden="true" width={15} height={15} />}
                    <span className="min-w-0 flex-1 truncate"><span className="text-[var(--ink)]">{r.title}</span> <span className="text-xs">· {r.hint}</span></span>
                    {i === active && <CornerDownLeft aria-hidden="true" width={14} height={14} />}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

export function CommandPalette({ entries }: { entries: PaletteEntry[] }) {
  const router = useRouter();
  return <Palette entries={entries} navigate={(href) => router.push(href, { transitionTypes: ["nav-forward"] })} />;
}

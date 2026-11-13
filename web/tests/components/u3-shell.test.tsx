// @vitest-environment jsdom
/**
 * U3 app shell: a ⌘K palette that jumps to any case or objection, a breadcrumb that says where
 * you are, and a 404 that offers a way back instead of a dead end.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { crumbs } from "@/components/ui/breadcrumb";
import { Palette, type PaletteEntry } from "@/components/ui/command-palette";
import NotFound from "@/app/not-found";

afterEach(cleanup);

const ENTRIES: PaletteEntry[] = [
  { href: "/cases/P01", title: "P01 · Dr. Avery Quillfeather", hint: "renewable energy engineering", kind: "case" },
  { href: "/cases/P08", title: "P08 · Ellis Marrowfield", hint: "renewable energy engineering", kind: "case" },
  { href: "/cases/P08#item-prong-judging-whole", title: "judging / whole", hint: "P08 · Ellis Marrowfield", kind: "item" },
  { href: "/cases/P02#item-prong-judging-whole", title: "judging / whole", hint: "P02 · Dr. Sable Wintermere", kind: "item" },
];

describe("command palette", () => {
  it("opens with Ctrl+K or ⌘K and closes with Escape", async () => {
    render(<Palette entries={ENTRIES} navigate={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.keyboard("{Control>}k{/Control}");
    expect(screen.getByRole("dialog", { name: /jump to/i })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("combobox"));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.keyboard("{Meta>}k{/Meta}");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("matches every word in any order, across cases and objections", async () => {
    render(<Palette entries={ENTRIES} navigate={() => {}} />);
    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.type(screen.getByRole("combobox"), "judging marrow");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringMatching(/judging \/ whole.*P08/)]);
  });

  it("goes to the chosen entry with the arrow keys and Enter", async () => {
    const navigate = vi.fn();
    render(<Palette entries={ENTRIES} navigate={navigate} />);
    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.type(screen.getByRole("combobox"), "P0");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(navigate).toHaveBeenCalledWith("/cases/P08");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says when nothing matches", async () => {
    render(<Palette entries={ENTRIES} navigate={() => {}} />);
    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.type(screen.getByRole("combobox"), "zzz");
    expect(screen.getByText(/no case or objection matches/i)).toBeTruthy();
  });
});

describe("breadcrumb", () => {
  it("names where you are", () => {
    expect(crumbs("/")).toEqual([{ label: "Review queue", href: "/" }]);
    expect(crumbs("/cases/P08")).toEqual([{ label: "Review queue", href: "/" }, { label: "P08", href: "/cases/P08" }]);
    expect(crumbs("/decisions/AUG172026_02B2203")).toEqual([{ label: "Review queue", href: "/" }, { label: "AAO AUG172026_02B2203", href: "/decisions/AUG172026_02B2203" }]);
  });
});

describe("not found", () => {
  it("offers a way back", () => {
    render(<NotFound />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/not found/i);
    expect(screen.getByRole("link", { name: /review queue/i }).getAttribute("href")).toBe("/");
  });
});

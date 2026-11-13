// @vitest-environment jsdom
/**
 * U0 design foundation: every status and item kind has an icon as well as a colour (so
 * nothing is colour-only), a theme toggle that persists and never flashes, and a brand mark.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrandMark } from "@/components/ui/brand-mark";
import { KindIcon, StatusIcon } from "@/components/ui/icons";
import { THEME_KEY, ThemeToggle, themeScript } from "@/components/ui/theme";

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("semantic icons", () => {
  it.each([
    ["open", "Open"],
    ["resolved", "Resolved"],
    ["dismissed", "Dismissed"],
  ] as const)("labels the %s status for screen readers", (status, label) => {
    render(<StatusIcon status={status} />);
    expect(screen.getByRole("img", { name: label })).toBeTruthy();
  });

  it("gives each status and each item kind its own glyph", () => {
    const { container } = render(
      <>
        <StatusIcon status="open" /><StatusIcon status="resolved" /><StatusIcon status="dismissed" />
        <KindIcon kind="prong" /><KindIcon kind="waiver" /><KindIcon kind="manual" />
      </>,
    );
    const glyphs = [...container.querySelectorAll("svg")].map((s) => s.getAttribute("data-icon"));
    expect(new Set(glyphs).size).toBe(6);
  });

  it("can be decorative when a visible label sits next to it", () => {
    const { container } = render(<KindIcon kind="waiver" decorative />);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("img")).toBeNull();
  });
});

describe("theme", () => {
  it("cycles system, light, dark and remembers the choice", async () => {
    render(<ThemeToggle />);
    const button = screen.getByRole("button", { name: /theme: system/i });
    await userEvent.click(button);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
    await userEvent.click(button);
    expect(document.documentElement.dataset.theme).toBe("dark");
    await userEvent.click(button);
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(screen.getByRole("button", { name: /theme: system/i })).toBeTruthy();
  });

  it("applies a saved theme before first paint, so there is no flash", () => {
    localStorage.setItem(THEME_KEY, "dark");
    new Function(themeScript)();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("ignores a tampered saved value", () => {
    localStorage.setItem(THEME_KEY, "neon");
    new Function(themeScript)();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

describe("brand mark", () => {
  it("is a labelled image", () => {
    render(<BrandMark />);
    expect(screen.getByRole("img", { name: "Adjudicate" })).toBeTruthy();
  });
});

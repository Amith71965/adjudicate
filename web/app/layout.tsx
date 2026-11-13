import type { Metadata } from "next";
import { EB_Garamond, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import Link from "next/link";
import { Suspense } from "react";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { CommandPalette, type PaletteEntry } from "@/components/ui/command-palette";
import { ReviewerChip } from "@/components/ui/reviewer-chip";
import { itemAnchor, itemTitle } from "@/lib/review/format";
import { allCases } from "@/lib/review/server";
import { BrandMark } from "@/components/ui/brand-mark";
import { ThemeToggle } from "@/components/ui/theme";
import { themeScript } from "@/components/ui/theme-script";
import "./globals.css";

const garamond = EB_Garamond({ variable: "--font-garamond", subsets: ["latin"], weight: ["500", "600"] });
const plexSans = IBM_Plex_Sans({ variable: "--font-plex-sans", subsets: ["latin"], weight: ["400", "500"] });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500"] });

export const metadata: Metadata = {
  title: { default: "Adjudicate", template: "%s · Adjudicate" },
  description: "Adversarial pre-filing review for extraordinary-ability petitions, with an attorney in the loop.",
};

function paletteEntries(): PaletteEntry[] {
  return allCases().flatMap((c) => [
    { href: `/cases/${c.id}`, title: `${c.id} · ${c.beneficiary}`, hint: c.field, kind: "case" as const },
    ...c.items.map((i) => ({ href: `/cases/${c.id}#${itemAnchor(i.id)}`, title: itemTitle(i), hint: `${c.id} · ${c.beneficiary}`, kind: "item" as const })),
  ]);
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // data-theme is set by the inline script before React hydrates
    <html lang="en" suppressHydrationWarning className={`${garamond.variable} ${plexSans.variable} ${plexMono.variable} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="flex min-h-full flex-col font-sans">
        <header className="sticky top-0 z-30 border-b border-[var(--line)] bg-[color-mix(in_srgb,var(--paper)_85%,transparent)] backdrop-blur-md">
          <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4 sm:px-8">
            <Link href="/" className="flex items-center gap-2.5 rounded-md">
              <BrandMark size={26} />
              <span className="font-serif text-xl font-semibold tracking-tight">Adjudicate</span>
            </Link>
            <span className="mx-1 hidden h-5 w-px bg-[var(--line)] md:block" aria-hidden="true" />
            {/* the path is request data: stream it so dynamic routes still prerender their shell */}
            <Suspense fallback={<span className="hidden font-mono text-xs text-[var(--muted)] md:inline">Review queue</span>}><Breadcrumb /></Suspense>
            <div className="ml-auto flex items-center gap-3">
              <CommandPalette entries={paletteEntries()} />
              <Suspense fallback={null}><ReviewerChip /></Suspense>
              <ThemeToggle />
            </div>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}

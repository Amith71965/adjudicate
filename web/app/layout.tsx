import type { Metadata } from "next";
import { EB_Garamond, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import Link from "next/link";
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
            <span className="hidden font-mono text-[11px] tracking-[0.18em] text-[var(--muted)] uppercase sm:inline">pre-filing review</span>
            <div className="ml-auto">
              <ThemeToggle />
            </div>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}

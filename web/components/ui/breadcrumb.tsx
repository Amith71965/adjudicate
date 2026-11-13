"use client";
/** Where you are, in the app bar: Review queue / P08, or Review queue / AAO decision. */
import Link from "next/link";
import { usePathname } from "next/navigation";

export interface Crumb { label: string; href: string }

export function crumbs(pathname: string): Crumb[] {
  const out: Crumb[] = [{ label: "Review queue", href: "/" }];
  const [, section, id] = pathname.split("/");
  if (section === "cases" && id) out.push({ label: id, href: `/cases/${id}` });
  if (section === "decisions" && id) out.push({ label: `AAO ${id}`, href: `/decisions/${id}` });
  return out;
}

export function Breadcrumb() {
  const trail = crumbs(usePathname() ?? "/");
  return (
    <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1.5 font-mono text-xs text-[var(--muted)] md:flex">
      {trail.map((c, i) => (
        <span key={c.href} className="flex min-w-0 items-center gap-1.5">
          {i > 0 && <span aria-hidden="true">/</span>}
          {i === trail.length - 1 ? (
            <span aria-current="page" className="truncate text-[var(--ink)]">{c.label}</span>
          ) : (
            <Link href={c.href} transitionTypes={["nav-back"]} className="hover:text-[var(--ink)]">{c.label}</Link>
          )}
        </span>
      ))}
    </nav>
  );
}

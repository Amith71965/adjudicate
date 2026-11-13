/** Who is reviewing, from the reviewer cookie (self-reported; there is no authentication). */
import { cookies } from "next/headers";
import { REVIEWER_COOKIE } from "@/lib/review/server";

export async function ReviewerChip() {
  const name = (await cookies()).get(REVIEWER_COOKIE)?.value;
  if (!name) return null;
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
  return (
    <span className="flex items-center gap-2 text-xs text-[var(--muted)]" title="Reviewing as (self-reported)">
      <span aria-hidden="true" className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent-soft)] font-mono text-[11px] text-[var(--accent)]">{initials}</span>
      <span className="hidden max-w-32 truncate lg:inline">{name}</span>
      <span className="sr-only">Reviewing as {name}</span>
    </span>
  );
}

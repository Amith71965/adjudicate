import { FileQuestion } from "lucide-react";
import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center px-4 py-24 text-center">
      <FileQuestion aria-hidden="true" width={40} height={40} className="text-[var(--muted)]" />
      <h1 className="mt-4 font-serif text-4xl">Not found</h1>
      <p className="mt-3 text-[var(--muted)]">
        There is no case or decision at this address. Cases run from P01 to P16, and decision ids look like AUG172026_02B2203.
      </p>
      <Link href="/" className="mt-6 rounded-lg bg-[var(--ink)] px-4 py-2 text-sm text-[var(--paper)]">Back to the review queue</Link>
    </main>
  );
}

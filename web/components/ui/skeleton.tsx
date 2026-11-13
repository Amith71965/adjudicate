/** Placeholders shaped like the content they stand in for (shimmer off under reduced motion). */
const bar = "skeleton rounded-md bg-[var(--line)]";

export function QueueSkeleton() {
  return (
    <div className="mt-8 space-y-3" role="status" aria-busy="true" aria-label="Loading the review queue">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="grid grid-cols-[6rem_1fr_6rem_6rem] items-center gap-4 border-b border-[var(--line)] py-3">
          <div className={`${bar} h-4`} /><div className={`${bar} h-4 w-2/3`} /><div className={`${bar} h-4`} /><div className={`${bar} h-4`} />
        </div>
      ))}
    </div>
  );
}

export function CaseSkeleton() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8" role="status" aria-busy="true" aria-label="Loading the case">
      <div className={`${bar} h-3 w-24`} />
      <div className={`${bar} mt-6 h-10 w-80`} />
      <div className={`${bar} mt-3 h-4 w-56`} />
      <div className="mt-10 grid gap-8 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-4">
          {[0, 1, 2].map((i) => <div key={i} className={`${bar} h-48 rounded-2xl`} />)}
        </div>
        <div className={`${bar} h-72 rounded-2xl`} />
      </div>
    </div>
  );
}

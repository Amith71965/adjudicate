/** The Adjudicate mark: a serif-cut "A" whose crossbar is a balance beam, with a red seal. */
export function BrandMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} role="img" aria-label="Adjudicate" className={className}>
      <rect width="32" height="32" rx="8" fill="var(--ink)" />
      <path d="M9 24.5 15.2 7.5h1.6L23 24.5" fill="none" stroke="var(--paper)" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
      <path d="M8.5 17.5h15" stroke="var(--paper)" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="23.5" cy="9" r="2.6" fill="var(--seal)" />
    </svg>
  );
}

/** The Yamlet mark: a rounded badge with a "Y" stroke. */
export function Logo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden>
      <rect x="2" y="2" width="60" height="60" rx="14" fill="var(--color-primary)" />
      <rect x="12" y="12" width="40" height="40" rx="10" fill="none" stroke="#fff" strokeWidth="3.4" />
      <path d="M24 25 L32 34 L40 25 M32 34 L32 45" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="flex items-center gap-2.5">
      <Logo size={30} />
      <span className="text-[19px] font-bold tracking-tight text-ink">Yamlet</span>
    </span>
  );
}

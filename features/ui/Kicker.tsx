/** The small uppercase label the system uses to open a section. */

/** Small uppercase label, the system's recurring section marker. */
export function Kicker({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] tracking-[0.1em] text-neutral-700 uppercase">{children}</div>
  );
}

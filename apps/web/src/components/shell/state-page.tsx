import Link from "next/link";
import type { ReactNode } from "react";

export const primaryButton =
  "inline-flex min-h-11 items-center rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-zinc-50 hover:bg-accent-hover md:min-h-9";
const secondaryButton =
  "inline-flex min-h-11 items-center rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:border-zinc-500 md:min-h-9";

/**
 * The page body for not-found and error states. `centered` is for pages outside the app frame
 * (signed out, or the frame itself failed); inside the frame it sits where a page would.
 */
export function StatePage({
  title,
  body,
  actions,
  note,
  centered = false,
}: {
  title: string;
  body: string;
  actions?: ReactNode;
  note?: string;
  centered?: boolean;
}) {
  return (
    <main
      className={
        centered
          ? "mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4"
          : "flex max-w-2xl flex-col gap-6 px-4 py-10 md:px-10"
      }
    >
      <div>
        <h1 className="font-serif text-4xl tracking-tight text-balance">{title}</h1>
        <p className="mt-2 text-muted">{body}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {actions ?? (
          <Link href="/" className={primaryButton}>
            Back to projects
          </Link>
        )}
      </div>
      {note && <p className="text-xs text-faint">{note}</p>}
    </main>
  );
}

export function HomeLink({ label = "Back to projects" }: { label?: string }) {
  return (
    <Link href="/" className={secondaryButton}>
      {label}
    </Link>
  );
}

/** Placeholder while a page inside the frame loads: a heading bar and a few quiet blocks. */
export function LoadingPage({ label = "Loading…" }: { label?: string }) {
  const block = "rounded-2xl bg-surface motion-safe:animate-pulse";
  return (
    <main aria-busy="true" className="flex max-w-6xl flex-col gap-10 px-4 py-10 md:px-10">
      <p role="status" className="sr-only">
        {label}
      </p>
      <div aria-hidden className="flex flex-col gap-3">
        <div className="h-5 w-28 rounded-full bg-surface motion-safe:animate-pulse" />
        <div className="h-11 w-full max-w-lg rounded-xl bg-surface motion-safe:animate-pulse" />
      </div>
      <div aria-hidden className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className={`h-32 ${block}`} />
        ))}
      </div>
      <div aria-hidden className={`h-40 ${block}`} />
    </main>
  );
}

"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

/**
 * The phone sidebar: a <details> that works without JS, closed again whenever the route changes
 * (the project layout persists across pages, so it would otherwise stay open over the new page).
 * Escape closes it and hands focus back to the toggle.
 */
export function MobileMenu({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const path = usePathname();
  useEffect(() => {
    if (ref.current) ref.current.open = false;
  }, [path]);
  function onKeyDown(e: KeyboardEvent<HTMLDetailsElement>) {
    if (e.key !== "Escape" || !ref.current?.open) return;
    ref.current.open = false;
    ref.current.querySelector("summary")?.focus();
  }
  return (
    <details ref={ref} onKeyDown={onKeyDown} className="border-b border-line bg-rail md:hidden">
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between px-4 py-3 [&::-webkit-details-marker]:hidden">
        {summary}
      </summary>
      {children}
    </details>
  );
}

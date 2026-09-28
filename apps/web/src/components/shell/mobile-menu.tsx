"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";

/**
 * The phone sidebar: a <details> that works without JS, closed again whenever the route changes
 * (the project layout persists across pages, so it would otherwise stay open over the new page).
 */
export function MobileMenu({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const path = usePathname();
  useEffect(() => {
    if (ref.current) ref.current.open = false;
  }, [path]);
  return (
    <details ref={ref} className="border-b border-line bg-rail md:hidden">
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between px-4 py-3">
        {summary}
      </summary>
      {children}
    </details>
  );
}

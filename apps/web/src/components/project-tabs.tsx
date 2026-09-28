"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const SETTINGS_TABS = [
  { href: "/settings", label: "Limit", exact: true },
  { href: "/settings/accounts", label: "Where to post" },
  { href: "/settings/keys", label: "Keys" },
  { href: "/settings/spending", label: "Spending" },
  { href: "/settings/tokens", label: "Agent access" },
] as const;

/** Settings sections as pills under the page eyebrow (projects use the sidebar instead). */
export function SettingsTabs() {
  const path = usePathname();
  return (
    <nav aria-label="Settings" className="mt-2 flex gap-1 overflow-x-auto">
      {SETTINGS_TABS.map((t) => {
        const active = path === t.href || (!("exact" in t && t.exact) && path.startsWith(`${t.href}/`));
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-11 items-center whitespace-nowrap rounded-full px-3 py-1 text-sm md:min-h-8 ${active ? "bg-raised text-ink" : "text-muted hover:text-ink"}`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const PROJECT_TABS = [
  { href: "today", label: "Today" },
  { href: "plan", label: "Plan" },
  { href: "content", label: "Content" },
  { href: "queue", label: "Queue" },
  { href: "results", label: "Results" },
] as const;

const SETTINGS_TABS = [
  { href: "/settings", label: "Limit" },
  { href: "/settings/accounts", label: "Where to post" },
  { href: "/settings/keys", label: "Keys" },
  { href: "/settings/spending", label: "Spending" },
] as const;

function Tabs({ items }: { items: readonly { href: string; label: string }[] }) {
  const path = usePathname();
  return (
    <nav className="border-b border-zinc-800">
      <div className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-4">
        {items.map((t) => {
          const active = path === t.href || path.startsWith(`${t.href}/`);
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${active ? "border-zinc-200 text-zinc-100" : "border-transparent text-zinc-400 hover:text-zinc-200"}`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

/** The project nav of §2.2, rendered by each /p/[slug]/* page under the Header. */
export function ProjectTabs({ slug }: { slug: string }) {
  return <Tabs items={PROJECT_TABS.map((t) => ({ href: `/p/${slug}/${t.href}`, label: t.label }))} />;
}

export function SettingsTabs() {
  return <Tabs items={SETTINGS_TABS} />;
}

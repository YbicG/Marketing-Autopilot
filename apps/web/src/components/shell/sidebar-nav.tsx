"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./icons";

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  /** Match only this exact path (Home, Overview). */
  exact?: boolean;
  /** Other paths that light this item up, e.g. the old /today under Overview. */
  also?: string[];
  badge?: number;
  children?: { href: string; label: string }[];
}

function under(path: string, href: string): boolean {
  return path === href || path.startsWith(`${href}/`);
}

function isActive(path: string, it: NavItem): boolean {
  if (it.exact ? path === it.href : under(path, it.href)) return true;
  return [...(it.also ?? []), ...(it.children ?? []).map((c) => c.href)].some((h) => under(path, h));
}

/** The sidebar's link list. Groups with children open their sub-links when you're inside them. */
export function SidebarNav({ items, label }: { items: NavItem[]; label: string }) {
  const path = usePathname();
  return (
    <nav aria-label={label} className="flex flex-col gap-0.5">
      {items.map((it) => {
        const active = isActive(path, it);
        return (
          <div key={it.href}>
            <Link
              href={it.href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
                active ? "bg-raised text-ink" : "text-muted hover:bg-surface hover:text-ink"
              }`}
            >
              <Icon name={it.icon} className={`size-4 ${active ? "text-accent" : "text-faint"}`} />
              <span className="flex-1">{it.label}</span>
              {it.badge ? (
                <span className="rounded-full bg-warn-soft px-1.5 py-px text-xs font-medium tabular-nums text-warn">{it.badge}</span>
              ) : null}
            </Link>
            {active && it.children && (
              <div className="mb-1 ml-[19px] mt-0.5 flex flex-col border-l border-line pl-3">
                {it.children.map((c) => (
                  <Link
                    key={c.href}
                    href={c.href}
                    aria-current={under(path, c.href) ? "page" : undefined}
                    className={`rounded-md px-2 py-1 text-[13px] ${under(path, c.href) ? "text-ink" : "text-faint hover:text-ink"}`}
                  >
                    {c.label}
                  </Link>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

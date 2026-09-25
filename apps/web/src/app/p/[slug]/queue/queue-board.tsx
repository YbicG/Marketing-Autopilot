"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PostDrawer } from "@/components/publishing/post-drawer";
import { MOVABLE_STATES, platformName, stateName, STATE_TONE } from "@/components/publishing/labels";
import type { QueueChip } from "@/components/publishing/types";
import { postJson } from "@/lib/post-json";

export interface BoardDay {
  day: string;
  /** "Tue 20" */
  label: string;
  isToday: boolean;
  isPast: boolean;
  /** Month view: false for the leading/trailing days of other months. */
  inRange: boolean;
  chips: QueueChip[];
}

/** Week / month grid with native HTML5 drag-to-reschedule (same local time, new day). Cap conflicts in red. */
export function QueueBoard({ days, view }: { days: BoardDay[]; view: "week" | "month" }) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function drop(day: string, postId: string) {
    setOver(null);
    setDragging(null);
    setMoving(postId);
    setError(null);
    const out = await postJson(`/api/posts/${postId}/reschedule`, { day });
    setMoving(null);
    if (!out.ok) setError(out.error);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <p className="rounded-md border border-red-900 bg-red-950/30 px-3 py-2 text-sm text-red-200" role="alert">
          {error}
        </p>
      )}
      <div className="grid grid-cols-7 gap-1 text-xs text-zinc-500">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="px-1">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {days.map((d) => {
          const droppable = !d.isPast && !!dragging;
          return (
            <div
              key={d.day}
              onDragOver={(e) => {
                if (!droppable) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setOver(d.day);
              }}
              onDragLeave={() => setOver((cur) => (cur === d.day ? null : cur))}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("text/plain");
                if (id && droppable) void drop(d.day, id);
              }}
              className={`flex flex-col gap-1 rounded-md border p-1.5 ${view === "week" ? "min-h-48" : "min-h-24"} ${
                over === d.day ? "border-sky-600 bg-sky-950/30" : d.isToday ? "border-zinc-500" : "border-zinc-800"
              } ${d.inRange ? "" : "opacity-40"} ${d.isPast ? "bg-zinc-950" : ""}`}
            >
              <div className={`text-xs ${d.isToday ? "font-semibold text-zinc-100" : "text-zinc-500"}`}>{d.label}</div>
              {d.chips.map((c) => {
                const movable = MOVABLE_STATES.has(c.state);
                const conflict = c.conflicts.length > 0;
                return (
                  <button
                    key={c.id}
                    type="button"
                    draggable={movable}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", c.id);
                      e.dataTransfer.effectAllowed = "move";
                      setDragging(c.id);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setOver(null);
                    }}
                    onClick={() => setOpen(c.id)}
                    title={conflict ? c.conflicts.join(" ") : `${platformName(c.platform)} · ${stateName(c.state)}`}
                    className={`flex flex-col items-start rounded border px-1.5 py-1 text-left text-xs ${
                      conflict ? "border-red-600 bg-red-950/40 text-red-100" : STATE_TONE[c.state] ?? "border-zinc-700"
                    } ${movable ? "cursor-grab" : ""} ${moving === c.id ? "opacity-50" : ""}`}
                  >
                    <span className="font-medium">
                      {c.time} · {platformName(c.platform)}
                    </span>
                    {view === "week" && <span className="text-[11px] opacity-80">{stateName(c.state)}</span>}
                    {view === "week" && conflict && <span className="text-[11px] text-red-300">{c.conflicts[0]}</span>}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-zinc-500">Drag a post to another day to move it. It keeps its time; red means it would break a daily limit.</p>
      {open && <PostDrawer postId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

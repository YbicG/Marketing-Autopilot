import { STATUS_LABEL, STATUS_TONE, type BroadcastStatus } from "./labels";

export function StatusPill({ status }: { status: BroadcastStatus }) {
  return <span className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-xs ${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>;
}

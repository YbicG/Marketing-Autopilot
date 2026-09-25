/** A URL shown as its host, as a small outbound link. Non-http(s) values render as nothing. */
export function SourceLink({ url, className = "" }: { url: string | null | undefined; className?: string }) {
  const host = hostOf(url);
  if (!url || !host) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className={`text-xs text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline ${className}`}
    >
      {host}
    </a>
  );
}

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

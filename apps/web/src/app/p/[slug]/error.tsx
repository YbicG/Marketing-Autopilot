"use client";
import { HomeLink, primaryButton, StatePage } from "@/components/shell/state-page";

/** A project page threw. Rendered inside the frame so the sidebar stays; `reset` re-renders it. */
export default function ProjectError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <StatePage
      title="Something didn't work"
      body="This page hit a problem while loading. Nothing you've set up has changed. Try again, or go back to Home."
      note={error.digest ? `Reference ${error.digest} (in the server logs)` : undefined}
      actions={
        <>
          <button type="button" onClick={reset} className={primaryButton}>
            Try again
          </button>
          <HomeLink label="Home" />
        </>
      }
    />
  );
}

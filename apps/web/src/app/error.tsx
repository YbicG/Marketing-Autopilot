"use client";
import { HomeLink, primaryButton, StatePage } from "@/components/shell/state-page";

/** A page (or the app frame) threw while rendering. `reset` re-renders the segment. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <StatePage
      centered
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

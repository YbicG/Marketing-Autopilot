"use client";
import "./globals.css";

/** The root layout itself failed, so this brings its own <html>. Kept plain: no fonts, no frame. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen font-sans">
        <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4">
          <div>
            <h1 className="font-serif text-4xl tracking-tight">Something didn&apos;t work</h1>
            <p className="mt-2 text-muted">The app couldn&apos;t load. Nothing you&apos;ve set up has changed. Try again in a moment.</p>
          </div>
          <div>
            <button
              type="button"
              onClick={reset}
              className="min-h-11 rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-zinc-50 hover:bg-accent-hover"
            >
              Try again
            </button>
          </div>
          {error.digest && <p className="text-xs text-faint">Reference {error.digest} (in the server logs)</p>}
        </main>
      </body>
    </html>
  );
}

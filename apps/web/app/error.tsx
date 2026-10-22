"use client";

/** Shown if rendering fails (for example an index file that passed validation but is still inconsistent). */
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <main className="empty">
      <div className="empty__inner">
        <h1 className="empty__title">Something in that index couldn&apos;t be read.</h1>
        <p className="empty__lede">{error.message}</p>
        <div className="empty__actions">
          <button className="btn btn--primary btn--big" onClick={() => (window.location.href = window.location.pathname)}>
            Start over
          </button>
          <button className="btn btn--big" onClick={reset}>
            Try again
          </button>
        </div>
        <div className="empty__how">
          <p>Re-create the index with the current version: contextcode index ./your-project -o index.json</p>
        </div>
      </div>
    </main>
  );
}

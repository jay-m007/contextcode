"use client";

/** First screen: what this is, how to get an index, and a demo to try right away. */
export function EmptyState({ onOpen, onDemo, error }: { onOpen: () => void; onDemo: () => void; error: string | null }) {
  return (
    <main className="empty">
      <div className="empty__inner">
        <h1 className="empty__title">
          Give the AI the right code, not all of it.
        </h1>
        <p className="empty__lede">
          ContextCode ranks a project&apos;s files for your question, explains each pick, and packs the best ones into a token budget you choose. Paste the result into
          any AI assistant.
        </p>
        <div className="empty__actions">
          <button className="btn btn--primary btn--big" onClick={onDemo}>
            Try it on ArchGuard&apos;s code
          </button>
          <button className="btn btn--big" onClick={onOpen}>
            Open an index file
          </button>
        </div>
        {error && (
          <p className="empty__error" role="alert">
            {error}
          </p>
        )}
        <div className="empty__how">
          <h2>Index your own project</h2>
          <pre className="mono">contextcode index ./my-project -o index.json</pre>
          <p>Then open or drop index.json here. Everything stays in your browser; nothing is uploaded.</p>
        </div>
      </div>
    </main>
  );
}

"use client";

type ErrorPageProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function ErrorPage({ reset }: ErrorPageProps) {
  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <p className="eyebrow">APPLICATION STATUS</p>
          <h1>Something went wrong</h1>
          <p className="page-description">
            The page could not be displayed. No wallet or transaction action is available in this
            foundation.
          </p>
        </div>
      </section>
      <section className="ui-card error-card" role="alert">
        <p className="error-card__title">Page error</p>
        <p>
          Try loading this page again. If the problem continues, restart the development server.
        </p>
        <button className="error-retry" onClick={() => reset()} type="button">
          Try again
        </button>
      </section>
    </div>
  );
}

import Link from "next/link";

export default function NotFound() {
  return (
    <section className="ui-card not-found">
      <p className="eyebrow">404 · PAGE NOT FOUND</p>
      <h1>This page isn’t available</h1>
      <p>The requested page does not exist in the RESCORA foundation.</p>
      <Link className="text-link" href="/">
        Return to Positions
      </Link>
    </section>
  );
}

import Link from "next/link";
import { buildSidebarView, type SetupStatus } from "../modules/setup";

export function SetupBlock({ status }: { status: SetupStatus }) {
  const view = buildSidebarView(status);
  return (
    <section className="setup" aria-labelledby="setup-h">
      <h2 id="setup-h">Setup</h2>
      <ul>
        {view.lines.map((l) => (
          <li key={l.label} className={l.ok ? "ok" : "bad"}>
            <span aria-hidden="true">{l.ok ? "✓" : "!"}</span> {l.label}: {l.text}
          </li>
        ))}
      </ul>
      {view.needsSetup ? <Link href="/">Finish setup on Home</Link> : null}
      <p>{view.lastSync}</p>
    </section>
  );
}

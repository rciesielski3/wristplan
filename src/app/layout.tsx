import { connection } from "next/server";
import type { ReactNode } from "react";
import "./globals.css";
import { SetupBlock } from "./SetupBlock";
import { SideNav } from "./SideNav";
import { loadSetupStatus } from "./setupDeps";

export const metadata = { title: "wristplan" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  const status = await loadSetupStatus();
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#content">
          Skip to content
        </a>
        <div className="shell">
          <aside className="side">
            <div className="brand">wristplan</div>
            <SideNav />
            {status ? <SetupBlock status={status} /> : null}
          </aside>
          <main id="content" tabIndex={-1}>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}

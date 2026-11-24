import type { ReactNode } from "react";
import "./globals.css";
import { SideNav } from "./SideNav";

export const metadata = { title: "wristplan" };

export default function RootLayout({ children }: { children: ReactNode }) {
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
          </aside>
          <main id="content" tabIndex={-1}>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}

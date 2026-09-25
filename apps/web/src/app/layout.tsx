import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "Marketing Autopilot" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}

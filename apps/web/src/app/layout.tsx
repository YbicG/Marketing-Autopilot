import type { ReactNode } from "react";
import { Geist, Instrument_Serif } from "next/font/google";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-instrument-serif" });

export const metadata = { title: "Marketing Autopilot" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`dark ${geist.variable} ${serif.variable}`}>
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}

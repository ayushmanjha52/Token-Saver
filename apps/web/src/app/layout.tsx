import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Self-hosted (latin subset, SIL OFL; licences in src/fonts). Builds and
// deploys do not depend on reaching Google Fonts, and no reader's browser
// is sent to a third party to render the page.
const display = localFont({
  src: [
    { path: "../fonts/instrument-serif-400.woff2", weight: "400", style: "normal" },
    { path: "../fonts/instrument-serif-400-italic.woff2", weight: "400", style: "italic" },
  ],
  variable: "--font-display",
  display: "swap",
});
const mono = localFont({
  src: [
    { path: "../fonts/plex-mono-400.woff2", weight: "400" },
    { path: "../fonts/plex-mono-500.woff2", weight: "500" },
    { path: "../fonts/plex-mono-600.woff2", weight: "600" },
  ],
  variable: "--font-mono",
  display: "swap",
});
const sans = localFont({
  src: [
    { path: "../fonts/hanken-grotesk-400.woff2", weight: "400" },
    { path: "../fonts/hanken-grotesk-500.woff2", weight: "500" },
    { path: "../fonts/hanken-grotesk-600.woff2", weight: "600" },
  ],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "TokenGrid",
  description: "Metered AI token spend, per person, on one scale.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable} ${sans.variable}`}>
      <body>{children}</body>
    </html>
  );
}

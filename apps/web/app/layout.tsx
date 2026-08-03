import type { Metadata, Viewport } from "next";
import { Archivo, Inter_Tight, JetBrains_Mono } from "next/font/google";
import { tokens } from "@overwatch/ui";
import "./globals.css";

// Type roles (CLAUDE.md #11): Archivo (width axis) for display, Inter Tight
// for human text, JetBrains Mono for machine-produced values.
const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  axes: ["wdth"],
});

const interTight = Inter_Tight({
  variable: "--font-inter-tight",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Overwatch Tally",
  description: "The operating record for a working livestock operation.",
};

// exercises the source-linked workspace chain (@overwatch/ui → web)
// end to end through tsc and next build — and matches the marketing site
export const viewport: Viewport = {
  themeColor: tokens.navy,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${archivo.variable} ${interTight.variable} ${jetbrainsMono.variable} font-sans antialiased`}
      >
        {children}
      </body>
    </html>
  );
}

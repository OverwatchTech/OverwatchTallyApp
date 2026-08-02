import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { tokens } from "@overwatch/ui";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
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
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}

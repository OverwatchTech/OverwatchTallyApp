import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Instrument_Sans } from "next/font/google";
import { tokens } from "@overwatch/ui";
import "./globals.css";

/*
  Type roles. The approved mockup (docs/reference/portal-mockup.html) uses
  Instrument Sans for everything human and IBM Plex Mono for everything a
  machine produced — the CLAUDE.md #11 distinction, in the owner's faces.
  Loaded through next/font/google so they are self-hosted: the mockup's
  <link> to fonts.googleapis.com would be a render-blocking third-party
  request and there is no CDN allowance in this stack.

  Instrument Sans is variable over wght 400–700; the mockup asks for 800 and
  Google clamps it to 700, so the variable face is the faithful load. IBM
  Plex Mono is not variable, so its weights are named.
*/
const instrumentSans = Instrument_Sans({
  variable: "--font-instrument-sans",
  subsets: ["latin"],
  display: "swap",
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
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
    // The font variables go on <html>, not <body>: globals.css resolves
    // --mono (and Tailwind's --font-mono) in :root, and a custom property
    // that references an undefined variable is invalid at computed-value
    // time — declaring the faces one level down silently kills every mono
    // number on the page.
    <html
      lang="en"
      className={`${instrumentSans.variable} ${ibmPlexMono.variable}`}
    >
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}

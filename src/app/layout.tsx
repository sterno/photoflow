// Root App Router layout — wraps every route in the global fonts, Bootstrap
// CSS, and the SessionProvider (via Providers) so client components can
// read the auth session without each page setting it up.
//
// The whole app runs in Bootstrap's dark theme (data-bs-theme="dark"), with
// the navy + stream-accent palette defined in globals.css. Typography pairs
// Bricolage Grotesque (display/brand) with Hanken Grotesk (body/UI) — both
// exposed as CSS variables consumed in globals.css.
import type { Metadata } from "next";
import { Bricolage_Grotesque, Hanken_Grotesk } from "next/font/google";
import 'bootstrap/dist/css/bootstrap.min.css';
import "./globals.css";
import { Providers } from "./providers";

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["500", "600", "700", "800"],
  display: "swap",
});

const body = Hanken_Grotesk({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "PhotoFlow",
  description: "Streamlined photography workflow for event coverage",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-bs-theme="dark" className={`${display.variable} ${body.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

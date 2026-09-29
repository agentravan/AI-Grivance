import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Inter, JetBrains_Mono, Orbitron } from "next/font/google";
import "./globals.css";

const orbitron = Orbitron({ subsets: ["latin"], variable: "--font-orbitron", weight: ["500", "700", "900"] });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });

export const metadata: Metadata = {
  title: "AEGIS · People Assistant",
  description: "Voice-first assistant for Learning & Development and HR policy guidance.",
  robots: { index: false, follow: false }, // internal tool — keep out of search engines
};

export const viewport: Viewport = {
  themeColor: "#02050b",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${orbitron.variable} ${inter.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}

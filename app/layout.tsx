import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GerritDiff — A better Gerrit diff viewer",
  description: "Open any public Gerrit change in a fast, focused, beautiful diff viewer.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="light">
      <body>{children}</body>
    </html>
  );
}

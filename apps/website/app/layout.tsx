import type { Metadata } from 'next';
import { JetBrains_Mono, Outfit } from 'next/font/google';
import './globals.css';

const outfit = Outfit({
  subsets: ['latin'],
  variable: '--font-outfit',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL('https://dashsquad.ai'),
  title: 'DashSquad — Your AI Team, Always On',
  description:
    "DashSquad lets you create AI agents — each with its own role. They work on their own, around the clock, even when you're not watching.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${outfit.variable} ${jetbrainsMono.variable}`}>
      <body className="font-outfit">{children}</body>
    </html>
  );
}

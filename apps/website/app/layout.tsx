import { Outfit, JetBrains_Mono } from 'next/font/google';
import type { Metadata } from 'next';
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
  metadataBase: new URL('https://atrium.ai'),
  title: 'Atrium — Your Personal Operating System',
  description:
    'Atrium is the personal operating system for people who build. AI agents that learn, remember, and compound your advantage.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${outfit.variable} ${jetbrainsMono.variable}`}>
      <body className="font-outfit">{children}</body>
    </html>
  );
}

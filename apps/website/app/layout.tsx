import { GeistMono } from 'geist/font/mono';
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://dashsquad.ai'),
  title: 'Dash — Your AI Team, Always On',
  description:
    'Run autonomous AI agents on your computer. Dash lets you deploy, monitor, and chat with AI agents from a desktop app or CLI.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={GeistMono.variable}>
      <body>{children}</body>
    </html>
  );
}

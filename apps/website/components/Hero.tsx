'use client';

import { ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

const TERMINAL_LINES = [
  '$ git clone https://github.com/volumegambit/Dash',
  '$ npm install && npm run dev',
  '# Agents online. Mission Control ready.',
];

const DOWNLOAD_OPTIONS = [
  { label: 'macOS (DMG)', href: 'https://github.com/volumegambit/Dash/releases/latest' },
  { label: 'Windows (EXE)', href: 'https://github.com/volumegambit/Dash/releases/latest' },
  { label: 'Linux (AppImage)', href: 'https://github.com/volumegambit/Dash/releases/latest' },
];

function TerminalAnimation() {
  const [visibleLines, setVisibleLines] = useState(0);

  useEffect(() => {
    if (visibleLines >= TERMINAL_LINES.length) return;
    const timer = setTimeout(() => setVisibleLines((v) => v + 1), visibleLines === 0 ? 600 : 900);
    return () => clearTimeout(timer);
  }, [visibleLines]);

  return (
    <section
      aria-label="terminal"
      className="mx-auto mt-12 max-w-2xl rounded-lg border border-[#262626] bg-[#0d0d0d] p-6 font-mono text-sm"
    >
      {/* macOS dots */}
      <div className="mb-4 flex gap-2">
        <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <span className="h-3 w-3 rounded-full bg-[#28c840]" />
      </div>
      <div className="space-y-2">
        {TERMINAL_LINES.slice(0, visibleLines).map((line, i) => (
          <p key={line} className={line.startsWith('#') ? 'text-[#a3a3a3]' : 'text-[#fafafa]'}>
            {line}
          </p>
        ))}
        {visibleLines < TERMINAL_LINES.length && (
          <span className="inline-block h-4 w-2 animate-pulse bg-[#3b82f6]" aria-hidden />
        )}
      </div>
    </section>
  );
}

export function Hero() {
  const [dropdownOpen, setDropdownOpen] = useState(false);

  return (
    <section className="flex min-h-[90vh] flex-col items-center justify-center bg-[#0a0a0a] px-6 py-24 text-center">
      <h1 className="max-w-2xl text-5xl font-bold tracking-tight text-white sm:text-6xl">
        Your AI Team, <span className="text-[#3b82f6]">Always On</span>
      </h1>
      <p className="mt-6 max-w-xl text-lg text-[#a3a3a3]">
        Dash runs autonomous AI agents on your computer — handling tasks, making decisions, and
        getting work done while you focus on what matters.
      </p>
      <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
        {/* Download button with dropdown */}
        <div className="relative">
          <div className="flex">
            <Link
              id="download"
              href="https://github.com/volumegambit/Dash/releases/latest"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-l-md bg-[#3b82f6] px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#2563eb]"
            >
              Download for Mac
            </Link>
            <button
              type="button"
              onClick={() => setDropdownOpen((o) => !o)}
              aria-label="More download options"
              className="rounded-r-md border-l border-[#2563eb] bg-[#3b82f6] px-3 py-3 text-white transition-colors hover:bg-[#2563eb]"
            >
              <ChevronDown size={16} />
            </button>
          </div>
          {dropdownOpen && (
            <div className="absolute left-0 top-full z-10 mt-1 w-full min-w-48 rounded-md border border-[#262626] bg-[#111111] py-1 shadow-xl">
              {DOWNLOAD_OPTIONS.map((opt) => (
                <Link
                  key={opt.label}
                  href={opt.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block px-4 py-2 text-sm text-[#a3a3a3] transition-colors hover:bg-[#1a1a1a] hover:text-white"
                  onClick={() => setDropdownOpen(false)}
                >
                  {opt.label}
                </Link>
              ))}
            </div>
          )}
        </div>
        <Link
          href="https://docs.dashsquad.ai"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-[#a3a3a3] transition-colors hover:text-white"
          aria-label="Read the Docs"
        >
          Read the Docs →
        </Link>
      </div>
      <TerminalAnimation />
    </section>
  );
}

import { MessageCircle } from 'lucide-react';
import Link from 'next/link';

const DISCORD_URL = 'https://discord.gg/dash';

export function Community() {
  return (
    <section className="bg-[#111111] px-6 py-24">
      <div className="mx-auto max-w-2xl text-center">
        <MessageCircle className="mx-auto mb-6 h-10 w-10 text-[#3b82f6]" />
        <h2 className="mb-4 text-3xl font-bold tracking-tight text-white">
          Join the Dash community
        </h2>
        <p className="mb-8 text-[#a3a3a3]">
          Get help, share agents, and follow development on Discord.
        </p>
        <Link
          href={DISCORD_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-md bg-[#3b82f6] px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#2563eb]"
          aria-label="Join Discord"
        >
          Join Discord →
        </Link>
      </div>
    </section>
  );
}

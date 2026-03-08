import { Github } from 'lucide-react'
import Link from 'next/link'

export function Nav() {
  return (
    <nav className="sticky top-0 z-50 border-b border-[#262626] bg-[#0a0a0a]/90 backdrop-blur-sm">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <span className="font-mono text-lg font-semibold tracking-tight text-white">Dash</span>
        <div className="flex items-center gap-6">
          <Link
            href="https://dash-aa8db5b5.mintlify.app/introduction"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-[#a3a3a3] transition-colors hover:text-white"
          >
            Docs
          </Link>
          <Link
            href="https://github.com/volumegambit/Dash"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub"
            className="text-[#a3a3a3] transition-colors hover:text-white"
          >
            <Github size={18} />
          </Link>
          <Link
            href="#download"
            className="rounded-md bg-[#3b82f6] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#2563eb]"
          >
            Download
          </Link>
        </div>
      </div>
    </nav>
  )
}

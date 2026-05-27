'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

const INSTALL_COMMAND = 'curl -fsSL dashsquad.ai/install.sh | sh';

export function InstallSnippet() {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access denied — fail silently
    }
  }

  return (
    <div className="bg-surface border border-surface-border rounded-[10px] px-4 py-3.5 flex items-center justify-between gap-3 max-w-[460px] font-mono text-[13px] text-white/85">
      <span className="truncate">
        <span className="text-text-muted">$</span> {INSTALL_COMMAND}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        className="shrink-0 bg-brand/15 text-brand hover:bg-brand/25 transition-colors rounded-md px-2.5 py-1 text-[11px] font-semibold inline-flex items-center gap-1.5"
      >
        {copied ? (
          <>
            <Check size={12} /> Copied
          </>
        ) : (
          <>
            <Copy size={12} /> Copy
          </>
        )}
      </button>
    </div>
  );
}

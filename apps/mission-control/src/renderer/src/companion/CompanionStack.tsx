import { ChevronDown } from 'lucide-react';
import { CompanionTree } from './CompanionTree.js';
import { statusIcon, timeAgo, visibleCards } from './cards.js';
import type { CompanionSession, CompanionStatus } from './types.js';

const STATE_PHRASE: Record<CompanionStatus, string> = {
  working: 'working',
  needs: 'needs you',
  done: 'done · unseen',
  error: 'error',
};

function Icon({ status }: { status: CompanionStatus }): JSX.Element {
  const kind = statusIcon(status);
  if (kind === 'spinner') {
    return (
      <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-border border-t-[#3da5d9]" />
    );
  }
  if (kind === 'check') {
    return (
      <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-green text-[11px] font-extrabold text-black">
        ✓
      </span>
    );
  }
  if (kind === 'bang') {
    return (
      <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-yellow text-[12px] font-extrabold text-black">
        !
      </span>
    );
  }
  return (
    <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-red text-[11px] font-extrabold text-black">
      ×
    </span>
  );
}

function Card({
  session,
  now,
  onOpen,
}: {
  session: CompanionSession;
  now: number;
  onOpen: (id: string) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onOpen(session.conversationId)}
      className="companion-slide-in w-[300px] rounded-lg border border-border bg-card-bg p-3 text-left shadow-lg transition-colors hover:bg-card-hover"
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="truncate font-[family-name:var(--font-display)] text-sm font-semibold text-foreground">
          {session.title}
        </h4>
        <Icon status={session.status} />
      </div>
      <p className="mt-1 line-clamp-2 text-xs text-muted">{session.preview}</p>
      <div className="mt-1.5 text-[10px] text-muted">
        {session.agentName} · {STATE_PHRASE[session.status]} · {timeAgo(session.since, now)}
      </div>
    </button>
  );
}

export function CompanionStack({
  sessions,
  expanded,
  now,
  onToggle,
  onOpen,
}: {
  sessions: CompanionSession[];
  expanded: boolean;
  now: number;
  onToggle: () => void;
  onOpen: (conversationId: string) => void;
}): JSX.Element {
  let expandedCards: JSX.Element | null = null;
  if (expanded && sessions.length > 0) {
    const { shown, overflow } = visibleCards(sessions);
    expandedCards = (
      <>
        <button
          type="button"
          onClick={onToggle}
          aria-label="Collapse companion"
          className="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-card-bg text-muted hover:text-foreground"
        >
          <ChevronDown size={14} />
        </button>
        {shown.map((s) => (
          <Card key={s.conversationId} session={s} now={now} onOpen={onOpen} />
        ))}
        {overflow > 0 && (
          <div className="rounded-full border border-border bg-card-bg px-2.5 py-0.5 text-[11px] font-medium text-muted">
            +{overflow} more
          </div>
        )}
      </>
    );
  }
  return (
    <div className="flex flex-col items-end gap-2">
      {expandedCards}
      <button
        type="button"
        onClick={onToggle}
        aria-label="Toggle companion"
        className="cursor-pointer"
      >
        <CompanionTree statuses={sessions.map((s) => s.status)} />
      </button>
    </div>
  );
}

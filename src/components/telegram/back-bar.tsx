'use client';

import { ChevronLeft } from 'lucide-react';

/**
 * In-page back navigation for sub-screens, shown when Telegram's native back
 * button is unavailable (SDK not loaded). With the SDK, Telegram's header
 * arrow does the same job and this renders nothing.
 */
export function BackBar({ onBack, title, hidden }: { onBack: () => void; title?: string; hidden: boolean }) {
  if (hidden) return null;
  return (
    <div
      className="sticky top-0 z-10 flex items-center gap-1 px-2 py-2"
      style={{ background: 'var(--tg-secondary-bg)' }}
    >
      <button type="button" onClick={onBack} className="tg-link flex items-center gap-0.5 rounded-lg px-2 py-1.5 text-sm font-medium">
        <ChevronLeft className="h-5 w-5" />
        Back
      </button>
      {title && <span className="min-w-0 truncate text-sm font-semibold">{title}</span>}
    </div>
  );
}

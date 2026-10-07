import { Star } from 'lucide-react';
import { useToggleWatchlist, useWatchlist } from '../hooks/market';

export function WatchButton({ coinId }: { coinId: string }) {
  const { data } = useWatchlist();
  const toggle = useToggleWatchlist();
  const watched = data?.items.some((c) => c.id === coinId) ?? false;
  return (
    <button
      type="button"
      aria-label={watched ? 'Remove from watchlist' : 'Add to watchlist'}
      aria-pressed={watched}
      disabled={toggle.isPending}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle.mutate({ coinId, watched });
      }}
      className={watched ? 'text-warn' : 'text-muted hover:text-warn'}
    >
      <Star size={16} fill={watched ? 'currentColor' : 'none'} />
    </button>
  );
}

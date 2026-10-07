import { Bell } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMarkAllRead, useNotifications } from '../hooks/notifications';

export function NotificationBell() {
  const { data } = useNotifications();
  const markAll = useMarkAllRead();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const unread = data?.unreadCount ?? 0;

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button type="button" aria-label={`Notifications (${unread} unread)`} className="relative rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-text" onClick={() => setOpen((o) => !o)}>
        <Bell size={18} />
        {unread > 0 && (
          <span className="num absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-loss px-1 text-[10px] font-bold text-white">{unread > 9 ? '9+' : unread}</span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-80 rounded-xl border border-border bg-surface shadow-2xl">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <span className="text-sm font-semibold">Notifications</span>
            <button type="button" className="text-xs text-accent hover:underline disabled:opacity-50" disabled={unread === 0} onClick={() => markAll.mutate()}>
              Mark all read
            </button>
          </div>
          <ul className="max-h-80 divide-y divide-border overflow-y-auto">
            {(data?.items ?? []).slice(0, 6).map((n) => (
              <li key={n.id} className={`px-4 py-3 text-sm ${n.readAt ? 'text-muted' : ''}`}>
                <p className="font-medium">{n.title}</p>
                <p className="mt-0.5 text-xs text-muted">{n.body}</p>
              </li>
            ))}
            {data?.items.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted">You're all caught up</li>}
          </ul>
          <Link to="/notifications" onClick={() => setOpen(false)} className="block border-t border-border px-4 py-2.5 text-center text-xs text-accent hover:underline">
            View all
          </Link>
        </div>
      )}
    </div>
  );
}

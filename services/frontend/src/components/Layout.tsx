import { BellRing, FileDown, LayoutDashboard, LineChart, LogOut, Star, UserRound, Wallet } from 'lucide-react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { config } from '../config';
import { NotificationBell } from './NotificationBell';
import { Button } from './ui';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/portfolios', label: 'Portfolios', icon: Wallet },
  { to: '/markets', label: 'Markets', icon: LineChart },
  { to: '/watchlist', label: 'Watchlist', icon: Star },
  { to: '/alerts', label: 'Alerts', icon: BellRing },
  { to: '/files', label: 'Import / Export', icon: FileDown },
  { to: '/profile', label: 'Profile', icon: UserRound },
];

export function Layout() {
  const { user, logout } = useAuth();
  return (
    <div className="min-h-screen md:grid md:grid-cols-[220px_1fr]">
      <aside className="border-b border-border bg-surface md:min-h-screen md:border-b-0 md:border-r">
        <div className="flex items-center justify-between px-5 py-4 md:block">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            Crypto<span className="text-accent">Folio</span>
          </Link>
          <span title="APP_ENV (runtime config)" className="rounded bg-surface-2 px-2 py-0.5 font-mono text-[11px] uppercase text-muted md:mt-2 md:inline-block">
            {config.appEnv}
          </span>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:overflow-visible">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${isActive ? 'bg-surface-2 text-text' : 'text-muted hover:text-text'}`
              }
            >
              <Icon size={16} />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="min-w-0">
        <header className="flex items-center justify-end gap-3 border-b border-border px-4 py-3 md:px-8">
          <NotificationBell />
          {user?.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
          ) : (
            <span className="grid h-8 w-8 place-items-center rounded-full bg-surface-2 text-sm font-semibold text-muted">
              {user?.displayName.slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className="hidden text-sm sm:inline">{user?.displayName}</span>
          <Button variant="ghost" onClick={() => void logout()}>
            <LogOut size={14} />
            Log out
          </Button>
        </header>
        <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 md:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

import { Button, Card, EmptyState, ErrorBanner, PageHeader, Spinner } from '../components/ui';
import { useMarkAllRead, useMarkRead, useNotifications } from '../hooks/notifications';

export function NotificationsPage() {
  const { data, isLoading, error } = useNotifications();
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();
  return (
    <>
      <PageHeader
        title="Notifications"
        actions={<Button variant="ghost" disabled={!data?.unreadCount} onClick={() => markAll.mutate()}>Mark all read</Button>}
      />
      <ErrorBanner error={error} />
      {isLoading && <Spinner />}
      {data?.items.length === 0 && <EmptyState title="No notifications" />}
      <Card className="!p-0">
        <ul className="divide-y divide-border">
          {data?.items.map((n) => (
            <li key={n.id} className="flex items-start justify-between gap-4 px-5 py-4">
              <div className={n.readAt ? 'text-muted' : ''}>
                <p className="font-medium">{n.title}</p>
                <p className="mt-1 text-sm text-muted">{n.body}</p>
                <p className="mt-1 text-xs text-muted">{new Date(n.createdAt).toLocaleString()}</p>
              </div>
              {!n.readAt && (
                <button type="button" className="shrink-0 text-xs text-accent hover:underline" onClick={() => markRead.mutate(n.id)}>
                  Mark read
                </button>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

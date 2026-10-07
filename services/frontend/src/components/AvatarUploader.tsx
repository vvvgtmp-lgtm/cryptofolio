import { type ChangeEvent, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { api } from '../lib/client';
import type { UploadTarget, User } from '../lib/types';
import { uploadFile } from '../lib/upload';
import { ErrorBanner, errorMessage } from './ui';

const MAX_BYTES = 2 * 1024 * 1024;
// Must match the api allowlist; the content type is part of the signed upload URL.
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export function AvatarUploader() {
  const { user, setUser } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type)) return setError('Please choose a PNG, JPEG, WebP or GIF image.');
    if (file.size > MAX_BYTES) return setError('The image must be 2 MB or smaller.');
    setBusy(true);
    setError(null);
    try {
      // 1) ask the api for a presigned URL  2) upload directly to storage  3) tell the api which key to use
      const { uploadUrl, key } = await api.post<UploadTarget>('/me/avatar/upload-url', { contentType: file.type });
      await uploadFile(uploadUrl, file);
      setUser(await api.put<User>('/me/avatar', { key }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-5">
      {user?.avatarUrl ? (
        <img src={user.avatarUrl} alt="Your avatar" className="h-20 w-20 rounded-full object-cover" />
      ) : (
        <span className="grid h-20 w-20 place-items-center rounded-full bg-surface-2 text-2xl font-semibold text-muted">{user?.displayName.slice(0, 1).toUpperCase()}</span>
      )}
      <div className="space-y-2">
        <label className="inline-flex cursor-pointer items-center rounded-lg border border-border px-3.5 py-2 text-sm font-medium hover:bg-surface-2">
          {busy ? 'Uploading…' : 'Upload new picture'}
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" disabled={busy} onChange={onFile} />
        </label>
        <p className="text-xs text-muted">PNG, JPEG, WebP or GIF, up to 2 MB. Stored in object storage.</p>
        {error && <ErrorBanner error={new Error(error)} />}
      </div>
    </div>
  );
}

import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { AvatarUploader } from '../components/AvatarUploader';
import { Button, Card, ErrorBanner, Field, inputClass, PageHeader, SectionTitle } from '../components/ui';
import { api } from '../lib/client';
import type { User } from '../lib/types';

export function ProfilePage() {
  const { user, setUser } = useAuth();
  const [name, setName] = useState(user?.displayName ?? '');
  const save = useMutation({ mutationFn: (displayName: string) => api.patch<User>('/me', { displayName }), onSuccess: setUser });

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(name);
  }

  return (
    <>
      <PageHeader title="Profile" subtitle={user?.email} />
      <Card className="max-w-xl">
        <SectionTitle>Avatar</SectionTitle>
        <AvatarUploader />
      </Card>
      <Card className="max-w-xl">
        <SectionTitle>Display name</SectionTitle>
        <form onSubmit={submit} className="space-y-4">
          <ErrorBanner error={save.error} />
          <Field label="Name">
            <input className={inputClass} required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Button type="submit" disabled={save.isPending || name.trim() === user?.displayName}>
            {save.isSuccess && name.trim() === user?.displayName ? 'Saved' : 'Save'}
          </Button>
        </form>
      </Card>
    </>
  );
}

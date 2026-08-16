import { useEffect, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type { AdminUserSummary } from '@justybase/contracts';
import { api } from './api';

export function AdminPanel({ onClose }: { onClose(): void }): ReactElement {
  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [restoreFile, setRestoreFile] = useState<File | null>(null);

  useEffect(() => { void api.adminUsers().then(setUsers).catch(reason => setError(reason instanceof Error ? reason.message : 'Could not load users.')); }, []);

  async function createUser(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true); setError(''); setMessage('');
    try {
      const created = await api.createAdminUser({ username, password, role });
      setUsers(previous => [...previous, created].sort((left, right) => left.username.localeCompare(right.username)));
      setUsername(''); setPassword(''); setMessage('User created.');
    } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : 'Could not create user.'); }
    finally { setBusy(false); }
  }

  async function toggleUser(user: AdminUserSummary): Promise<void> {
    try { const updated = await api.updateAdminUser(user.id, { active: !user.active }); setUsers(previous => previous.map(item => item.id === updated.id ? updated : item)); }
    catch (reason: unknown) { setError(reason instanceof Error ? reason.message : 'Could not update user.'); }
  }

  async function resetPassword(user: AdminUserSummary): Promise<void> {
    const nextPassword = window.prompt(`New password for ${user.username} (at least 8 characters):`);
    if (!nextPassword) return;
    try { await api.updateAdminUser(user.id, { password: nextPassword }); setMessage('Password updated.'); }
    catch (reason: unknown) { setError(reason instanceof Error ? reason.message : 'Could not update password.'); }
  }

  async function downloadBackup(): Promise<void> {
    try {
      const backup = await api.adminBackup();
      const url = URL.createObjectURL(backup.blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = backup.fileName; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 100);
    } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : 'Backup failed.'); }
  }

  async function restoreBackup(): Promise<void> {
    if (!restoreFile || !window.confirm('Restore this backup? Current users, profiles, history and preferences will be replaced.')) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const bytes = new Uint8Array(await restoreFile.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      const result = await api.adminRestore({ fileName: restoreFile.name, contentBase64: window.btoa(binary), restoreConfirmed: true });
      setMessage(result.message);
      window.setTimeout(() => window.location.reload(), 1200);
    } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : 'Restore failed.'); }
    finally { setBusy(false); }
  }

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal-card admin-card"><div className="modal-header"><strong>Administration</strong><button type="button" className="secondary small" onClick={onClose}>Close</button></div>
      <form className="admin-create-form" onSubmit={event => void createUser(event)}><input placeholder="Username" value={username} onChange={event => setUsername(event.target.value)} /><input type="password" placeholder="Password (8+ characters)" value={password} onChange={event => setPassword(event.target.value)} /><select value={role} onChange={event => setRole(event.target.value as 'admin' | 'user')}><option value="user">User</option><option value="admin">Administrator</option></select><button disabled={busy}>{busy ? 'Creating…' : 'Create user'}</button></form>
      {error && <div className="error">{error}</div>}{message && <div className="success-message">{message}</div>}
      <div className="admin-user-list">{users.map(user => <div className="admin-user-row" key={user.id}><div><strong>{user.username}</strong><small>{user.role} · {user.active ? 'active' : 'disabled'}</small></div><div><button type="button" className="secondary small" onClick={() => void resetPassword(user)}>Password</button><button type="button" className="secondary small" onClick={() => void toggleUser(user)}>{user.active ? 'Disable' : 'Enable'}</button></div></div>)}</div>
      <div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={() => void downloadBackup()}>Download backup</button><label className="admin-restore-file">Restore backup<input type="file" accept=".sqlite,.db,application/vnd.sqlite3" onChange={event => setRestoreFile(event.target.files?.[0] ?? null)} /></label><button type="button" className="secondary" disabled={busy || !restoreFile} onClick={() => void restoreBackup()}>{busy ? 'Restoring…' : 'Restore selected'}</button></div>
    </section>
  </div>;
}

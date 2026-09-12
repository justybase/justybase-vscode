import { useMemo, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { DATABASE_KIND_OPTIONS } from '@justybase/contracts';
import type { DatabaseKind, RedactedConnectionProfile, UiConnectionProfileInput } from '@justybase/contracts';

interface ConnectionPanelProps {
  readonly initial?: RedactedConnectionProfile;
  readonly onSaved: (profile: RedactedConnectionProfile) => void;
  readonly onCancel: () => void;
}

interface DatabaseOption {
  readonly value: DatabaseKind;
  readonly label: string;
  readonly runtimeAvailable: boolean;
}

const databaseOptions: readonly DatabaseOption[] = DATABASE_KIND_OPTIONS.map(option => ({
  ...option,
  label: option.value === 'netezza'
    ? option.label
    : option.value === 'sqlite' || option.value === 'duckdb'
      ? `${option.label} · local file`
      : `${option.label} · authoring ready`,
  runtimeAvailable: option.value === 'netezza' || option.value === 'sqlite' || option.value === 'duckdb',
}));

function initialValue(profile: RedactedConnectionProfile | undefined): UiConnectionProfileInput {
  return {
    name: profile?.name ?? '',
    host: profile?.host ?? '',
    port: profile?.port ?? 5480,
    database: profile?.database ?? 'system',
    user: profile?.user ?? '',
    dbType: profile?.dbType ?? 'netezza',
    readOnly: profile?.readOnly ?? true,
  };
}

function localDatabase(kind: DatabaseKind): boolean {
  return kind === 'sqlite' || kind === 'duckdb';
}

function optionFor(kind: DatabaseKind): DatabaseOption {
  return databaseOptions.find(option => option.value === kind)
    ?? { value: kind, label: `${kind} · runtime unavailable`, runtimeAvailable: false };
}

function sameProfile(left: UiConnectionProfileInput, right: UiConnectionProfileInput): boolean {
  return left.name === right.name
    && left.host === right.host
    && left.port === right.port
    && left.database === right.database
    && left.user === right.user
    && left.dbType === right.dbType
    && left.readOnly === right.readOnly;
}

/** Electron connection editor. Password entry is deliberately main-process owned. */
export function ConnectionPanel({ initial, onSaved, onCancel }: ConnectionPanelProps): ReactElement {
  const [form, setForm] = useState<UiConnectionProfileInput>(() => initialValue(initial));
  const [changePassword, setChangePassword] = useState(false);
  const [busy, setBusy] = useState<'saving' | 'testing' | undefined>(undefined);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const local = localDatabase(form.dbType);
  const selectedOption = optionFor(form.dbType);
  const unchanged = useMemo(() => initial ? sameProfile(form, initialValue(initial)) : false, [form, initial]);

  const update = <K extends keyof UiConnectionProfileInput>(key: K, value: UiConnectionProfileInput[K]): void => {
    setForm(previous => ({ ...previous, [key]: value }));
    setError('');
    setSuccess('');
  };

  const requestPassword = async (): Promise<ReturnType<typeof window.justybaseElectron.requestCredential> extends Promise<infer T> ? T : never> => {
    return window.justybaseElectron.requestCredential('connection');
  };

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!selectedOption.runtimeAvailable) {
      setError('This dialect is ready for SQL authoring, but its Electron database runtime is not enabled yet.');
      return;
    }
    setBusy('saving'); setError(''); setSuccess('');
    try {
      const needsPassword = !local && (!initial || changePassword);
      const requestId = needsPassword ? await requestPassword() : undefined;
      const profile = initial
        ? await window.justybaseElectron.updateConnection(initial.id, form, requestId)
        : await window.justybaseElectron.createConnection(form, requestId);
      onSaved(profile);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Could not save connection.');
    } finally {
      setBusy(undefined);
    }
  }

  async function test(): Promise<void> {
    if (!selectedOption.runtimeAvailable) {
      setError('This dialect is ready for SQL authoring, but its Electron database runtime is not enabled yet.');
      return;
    }
    setBusy('testing'); setError(''); setSuccess('');
    try {
      const canUseStoredProfile = Boolean(initial && unchanged && !changePassword);
      if (canUseStoredProfile) {
        await window.justybaseElectron.testConnection(initial!.id);
      } else {
        const needsPassword = !local;
        const requestId = needsPassword ? await requestPassword() : undefined;
        await window.justybaseElectron.testConnectionProfile(form, requestId);
      }
      setSuccess('Connection succeeded.');
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Connection test failed.');
    } finally {
      setBusy(undefined);
    }
  }

  return <div className="electron-modal-backdrop" role="presentation">
    <section className="electron-modal-card electron-connection-card" role="dialog" aria-modal="true" aria-labelledby="electron-connection-title">
      <header className="electron-modal-header"><div><strong id="electron-connection-title">{initial ? 'Edit connection' : 'New connection'}</strong><small>{initial ? `Profile: ${initial.name}` : 'Add a database to the Explorer'}</small></div><button type="button" className="electron-icon-button" aria-label="Close connection editor" onClick={onCancel}>×</button></header>
      <form onSubmit={event => void submit(event)}>
        <div className="electron-connection-grid">
          <label>Database type<select value={form.dbType} onChange={event => update('dbType', event.target.value as DatabaseKind)}>{databaseOptions.map(option => <option key={option.value} value={option.value} disabled={!option.runtimeAvailable}>{option.label}</option>)}{!databaseOptions.some(option => option.value === form.dbType) && <option value={form.dbType} disabled>{selectedOption.label}</option>}</select><small className="electron-field-help">{selectedOption.runtimeAvailable ? 'Metadata, execution and result grid are available.' : 'Monaco authoring profile is available; runtime connection is not enabled.'}</small></label>
          <label>Profile name<input required maxLength={200} value={form.name} onChange={event => update('name', event.target.value)} autoFocus /></label>
          <label>Host<input required={!local} disabled={local} placeholder={local ? 'Local file / memory database' : 'db.example.com'} value={form.host} onChange={event => update('host', event.target.value)} /></label>
          <label>Port<input required={!local} disabled={local} type="number" min={1} max={65535} value={form.port} onChange={event => update('port', Number(event.target.value))} /></label>
          <label className="electron-connection-wide">Database{local && <small className="electron-field-help">Absolute file path or :memory:</small>}<input required maxLength={2048} value={form.database} onChange={event => update('database', event.target.value)} /></label>
          <label>User<input value={form.user} placeholder={local ? 'Optional' : 'Database user'} onChange={event => update('user', event.target.value)} /></label>
        </div>
        {!local && <div className="electron-secure-credential"><span className="electron-secure-icon">▣</span><div><strong>Password stays in the main process</strong><p>When you save or test, Electron opens a secure native prompt. The editor receives only a one-time request handle.</p></div></div>}
        {initial && !local && <label className="electron-checkbox"><input type="checkbox" checked={changePassword} onChange={event => { setChangePassword(event.target.checked); setError(''); setSuccess(''); }} /> Change stored password</label>}
        <label className="electron-checkbox"><input type="checkbox" checked={form.readOnly} onChange={event => update('readOnly', event.target.checked)} /> Read-only mode <small className="electron-field-help">Recommended for exploration</small></label>
        {error && <div className="electron-modal-error" role="alert">{error}</div>}
        {success && <div className="electron-modal-success" role="status">{success}</div>}
        <div className="electron-modal-actions"><button type="button" className="electron-secondary" disabled={busy !== undefined} onClick={() => void test()}>{busy === 'testing' ? 'Testing…' : 'Test connection'}</button><span className="electron-action-spacer" /><button type="button" className="electron-secondary" disabled={busy !== undefined} onClick={onCancel}>Cancel</button><button type="submit" disabled={busy !== undefined || !selectedOption.runtimeAvailable}>{busy === 'saving' ? 'Saving…' : initial ? 'Save changes' : 'Add connection'}</button></div>
      </form>
    </section>
  </div>;
}

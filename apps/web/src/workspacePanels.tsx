import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { DATABASE_KIND_OPTIONS, tryNormalizeDatabaseKind } from '@justybase/contracts';
import type {
  ConnectionProfileSummary,
  ConnectionProfileUpdate,
  DatabaseKind,
  EditorPreferences,
  WebUser,
} from '@justybase/contracts';
import { useApiClient, useOptionalApiClient, type ApiClient } from './api';

export function isTestLoginEnabled(): boolean {
  return (globalThis as { __JUSTYBASE_ENABLE_TEST_LOGIN__?: unknown }).__JUSTYBASE_ENABLE_TEST_LOGIN__ === true;
}

export function Login({ onLogin }: { onLogin(user: WebUser): void }): ReactElement {
  const api = useApiClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault(); setBusy(true); setError('');
    try { onLogin((await api.login(username, password)).user); } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : 'Login failed.'); } finally { setBusy(false); }
  }
  async function testLogin(): Promise<void> {
    setBusy(true); setError('');
    try { onLogin((await api.testLogin()).user); } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : 'Test login failed.'); } finally { setBusy(false); }
  }
  return <main className="auth-shell"><form className="card auth-card" onSubmit={event => void submit(event)}><div className="brand">JustyBase</div><h1>Web database editor</h1><p className="muted">Sign in to your self-hosted workspace.</p><label>Username<input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" /></label><label>Password<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" /></label>{error && <div className="error">{error}</div>}<button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>{isTestLoginEnabled() && <button type="button" className="secondary test-login-button" disabled={busy} onClick={() => void testLogin()}>Use test login data</button>}</form></main>;
}

interface WebConnectionOption {
  readonly value: DatabaseKind;
  readonly label: string;
  readonly runtimeAvailable: boolean;
}

const webDatabaseOptions: readonly WebConnectionOption[] = DATABASE_KIND_OPTIONS.map(option => ({
  ...option,
  label: option.value === 'netezza'
    ? option.label
    : option.value === 'sqlite' || option.value === 'duckdb'
      ? `${option.label} · local file`
      : `${option.label} · authoring ready`,
  runtimeAvailable: option.value === 'netezza' || option.value === 'sqlite' || option.value === 'duckdb',
}));

interface ConnectionFormState { name: string; host: string; port: number; database: string; user: string; password: string; dbType: DatabaseKind; readOnly: boolean; }

function webConnectionKind(value: ConnectionProfileSummary['dbType'] | undefined): DatabaseKind {
  if (typeof value !== 'string' || value.trim().length === 0) return 'netezza';
  return tryNormalizeDatabaseKind(value) ?? value;
}

function webConnectionOption(kind: DatabaseKind): WebConnectionOption {
  return webDatabaseOptions.find(option => option.value === kind)
    ?? { value: kind, label: `${kind} · runtime unavailable`, runtimeAvailable: false };
}

function localDatabase(kind: DatabaseKind): boolean {
  return kind === 'sqlite' || kind === 'duckdb';
}

export function ConnectionForm({ initial, onCreated, onCancel, api: providedApi }: { initial?: ConnectionProfileSummary; onCreated(connection: ConnectionProfileSummary): void; onCancel(): void; api?: ApiClient }): ReactElement {
  const contextApi = useOptionalApiClient();
  const client = providedApi ?? contextApi;
  if (!client) throw new Error('ConnectionForm requires an API client.');
  const api: ApiClient = client;
  const [form, setForm] = useState<ConnectionFormState>(() => ({ name: initial?.name ?? '', host: initial?.host ?? '', port: initial?.port ?? 5480, database: initial?.database ?? 'system', user: initial?.user ?? '', password: '', dbType: webConnectionKind(initial?.dbType), readOnly: initial?.readOnly ?? true }));
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testMessage, setTestMessage] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault(); setSaving(true); setError('');
    try {
      const selectedOption = webConnectionOption(form.dbType);
      if (!selectedOption.runtimeAvailable) {
        setError('This dialect is ready for SQL authoring, but its Web database runtime is not enabled yet.');
        return;
      }
      if (initial) {
        const input: ConnectionProfileUpdate = { ...form, password: form.password || undefined };
        onCreated(await api.updateConnection(initial.id, input));
      } else {
        onCreated(await api.createConnection(form));
      }
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Could not save connection.');
    } finally { setSaving(false); }
  }
  async function test(): Promise<void> {
    if (!webConnectionOption(form.dbType).runtimeAvailable) {
      setError('This dialect is ready for SQL authoring, but its Web database runtime is not enabled yet.');
      return;
    }
    setTesting(true); setTestMessage(''); setError('');
    try {
      if (initial && !form.password) {
        await api.testConnection(initial.id);
      } else {
        await api.testConnectionProfile(form);
      }
      setTestMessage('Connection succeeded.');
    }
    catch (reason: unknown) { setError(reason instanceof Error ? reason.message : 'Connection test failed.'); }
    finally { setTesting(false); }
  }
  const update = (key: keyof ConnectionFormState, value: string | number | boolean | DatabaseKind): void => setForm(previous => ({ ...previous, [key]: value }));
  const local = localDatabase(form.dbType);
  const selectedOption = webConnectionOption(form.dbType);
  return <form className="connection-form" onSubmit={event => void submit(event)}>
    <div className="connection-fields">
      <label htmlFor="connection-type">Database type<select id="connection-type" value={form.dbType} onChange={event => update('dbType', event.target.value as DatabaseKind)}>{webDatabaseOptions.map(option => <option key={option.value} value={option.value} disabled={!option.runtimeAvailable}>{option.label}</option>)}{!webDatabaseOptions.some(option => option.value === form.dbType) && <option value={form.dbType} disabled>{selectedOption.label}</option>}</select><span className="field-help">{selectedOption.runtimeAvailable ? 'Metadata, execution and Result Grid are available.' : 'SQL authoring profile is available; Web runtime connection is not enabled.'}</span></label>
      <label htmlFor="connection-name">Profile name<input id="connection-name" required value={form.name} onChange={event => update('name', event.target.value)} /></label>
      <label htmlFor="connection-host">Host<input id="connection-host" disabled={local} placeholder={local ? 'Not used for local databases' : undefined} value={form.host} onChange={event => update('host', event.target.value)} /></label>
      <label htmlFor="connection-port">Port<input id="connection-port" type="number" min="1" max="65535" disabled={local} value={form.port} onChange={event => update('port', Number(event.target.value))} /></label>
      <label htmlFor="connection-database">Database{local && <span className="field-help">File path or :memory:</span>}<input id="connection-database" required value={form.database} onChange={event => update('database', event.target.value)} /></label>
      <label htmlFor="connection-user">User<input id="connection-user" placeholder={local ? 'Optional' : undefined} value={form.user} onChange={event => update('user', event.target.value)} /></label>
      <label htmlFor="connection-password">{initial ? 'New password' : 'Password'}{local && <span className="field-help">Optional</span>}<input id="connection-password" type="password" autoComplete={initial ? 'new-password' : 'current-password'} value={form.password} onChange={event => update('password', event.target.value)} /></label>
    </div>
    <label className="checkbox"><input type="checkbox" checked={form.readOnly} onChange={event => update('readOnly', event.target.checked)} /> Read-only mode <span className="field-help">Recommended for exploration</span></label>
    {error && <div className="error" role="alert">{error}</div>}
    {testMessage && <div className="success-message" role="status">{testMessage} You can now save this profile.</div>}
    <div className="form-actions connection-actions-row"><button type="submit" disabled={saving || !selectedOption.runtimeAvailable}>{saving ? 'Saving…' : initial ? 'Save changes' : 'Add connection'}</button><button type="button" className="secondary" disabled={testing || saving || !selectedOption.runtimeAvailable} onClick={() => void test()}>{testing ? 'Testing…' : 'Test connection'}</button><button type="button" className="secondary" disabled={saving} onClick={onCancel}>Cancel</button></div>
  </form>;
}

export function EditorSettings({ value, onSave, onClose, onResetLayout }: { value: EditorPreferences; onSave(value: EditorPreferences): void; onClose(): void; onResetLayout?(): void }): ReactElement {
  const api = useApiClient();
  const [form, setForm] = useState(value);
  const [ruleText, setRuleText] = useState(() => Object.entries(value.linterRules).map(([code, level]) => `${code}=${level}`).join('\n'));
  const [ruleError, setRuleError] = useState('');
  const update = <K extends keyof EditorPreferences>(key: K, next: EditorPreferences[K]): void => setForm(previous => ({ ...previous, [key]: next }));
  async function save(): Promise<void> {
    setRuleError('');
    const linterRules: EditorPreferences['linterRules'] = { ...form.linterRules };
    for (const line of ruleText.split(/\r?\n/)) {
      const [rawCode, rawLevel] = line.split('=', 2).map(item => item.trim());
      if (!rawCode || !rawLevel) continue;
      if (!/^[A-Z][A-Z0-9_]*$/u.test(rawCode) || !['error', 'warning', 'information', 'hint', 'off'].includes(rawLevel)) {
        setRuleError(`Invalid rule entry: ${line}. Use CODE=error|warning|information|hint|off.`);
        return;
      }
      linterRules[rawCode] = rawLevel as EditorPreferences['linterRules'][string];
    }
    onSave(await api.updateEditorPreferences({ ...form, linterRules }));
  }
  return <div className="modal-backdrop"><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="editor-settings-title"><div className="section-title"><span id="editor-settings-title">Editor settings</span><button type="button" className="icon-button" aria-label="Close editor settings" onClick={onClose}>×</button></div><div className="settings-grid"><label>Font size<input type="number" min="10" max="32" value={form.fontSize} onChange={event => update('fontSize', Number(event.target.value))} /></label><label>Tab size<input type="number" min="1" max="16" value={form.tabSize} onChange={event => update('tabSize', Number(event.target.value))} /></label><label>Word wrap<select value={form.wordWrap} onChange={event => update('wordWrap', event.target.value as EditorPreferences['wordWrap'])}><option value="off">Off</option><option value="on">On</option><option value="bounded">Bounded</option></select></label><label>Keyword case<select value={form.keywordCase} onChange={event => update('keywordCase', event.target.value as EditorPreferences['keywordCase'])}><option value="upper">Uppercase</option><option value="lower">Lowercase</option><option value="preserve">Preserve</option></select></label><label className="checkbox"><input type="checkbox" checked={form.insertSpaces} onChange={event => update('insertSpaces', event.target.checked)} /> Insert spaces</label><label className="checkbox"><input type="checkbox" checked={form.minimap} onChange={event => update('minimap', event.target.checked)} /> Minimap</label><label className="checkbox"><input type="checkbox" checked={form.lineNumbers} onChange={event => update('lineNumbers', event.target.checked)} /> Line numbers</label><label className="checkbox"><input type="checkbox" checked={form.linterEnabled} onChange={event => update('linterEnabled', event.target.checked)} /> SQL linter</label><label className="checkbox"><input type="checkbox" checked={form.formatOnType} onChange={event => update('formatOnType', event.target.checked)} /> Format on type</label><label className="checkbox"><input type="checkbox" checked={form.formatOnSave} onChange={event => update('formatOnSave', event.target.checked)} /> Format on save</label><label className="checkbox"><input type="checkbox" checked={form.inlineTypeHints} onChange={event => update('inlineTypeHints', event.target.checked)} /> Inline type hints</label><label className="settings-rule-label">Rule levels<textarea rows={4} aria-invalid={Boolean(ruleError)} aria-describedby="settings-rule-help" placeholder="SQL025=warning\nNZP001=off" value={ruleText} onChange={event => { setRuleText(event.target.value); setRuleError(''); }} /><span id="settings-rule-help" className={ruleError ? 'settings-rule-error' : 'muted'}>{ruleError || 'One CODE=level per line: error, warning, information, hint or off.'}</span></label></div><div className="settings-actions"><div className="form-actions"><button type="button" onClick={() => void save()}>Save settings</button><button type="button" className="secondary" onClick={onClose}>Cancel</button></div><button type="button" className="secondary small settings-reset-layout" onClick={() => { onResetLayout?.(); onClose(); }}>Reset layout</button></div></section></div>;
}

export function StatusBar({ connectionName, database, lastQueryTime, overwrite }: { connectionName?: string; database: string; lastQueryTime: number | null; overwrite: boolean }): ReactElement {
  const timeStr = lastQueryTime
    ? new Date(lastQueryTime).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;
  return (
    <footer className="statusbar">
      <div className="statusbar-left">
        {connectionName && (
          <span className="statusbar-item" title="Connection">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 7V4h16v3" /><path d="M9 20h6" /><path d="M12 4v16" />
            </svg>
            {connectionName}
          </span>
        )}
        {database && (
          <span className="statusbar-item" title="Database">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
            </svg>
            {database}
          </span>
        )}
      </div>
      <div className="statusbar-right">
        {timeStr && (
          <span className="statusbar-item" title="Last query completed">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
            </svg>
            {timeStr}
          </span>
        )}
        <span className={`statusbar-item statusbar-ovr ${overwrite ? 'active' : ''}`} title={overwrite ? 'Overwrite mode (Press Insert to toggle)' : 'Insert mode (Press Insert to toggle)'}>
          {overwrite ? 'OVR' : 'INS'}
        </span>
      </div>
    </footer>
  );
}

export function HistoryPanel({ entries, onClose, onOpen }: { entries: Awaited<ReturnType<ApiClient['history']>>; onClose(): void; onOpen(entry: Awaited<ReturnType<ApiClient['history']>>[number]): void }): ReactElement {
  return <div className="modal-backdrop"><section className="modal-card history-card"><div className="section-title">Query history <button className="icon-button" onClick={onClose}>×</button></div>{entries.length === 0 ? <p className="muted">No queries yet.</p> : <div className="history-list">{entries.map(entry => <button className="history-entry" key={entry.id} onClick={() => onOpen(entry)}><span><strong>{entry.status}</strong> · {new Date(entry.createdAt).toLocaleString()} · {entry.rowCount.toLocaleString()} rows</span><code>{entry.sql}</code></button>)}</div>}</section></div>;
}

export function AuditPanel({ entries, onClose }: { entries: Awaited<ReturnType<ApiClient['audit']>>; onClose(): void }): ReactElement {
  return <div className="modal-backdrop"><section className="modal-card history-card audit-card"><div className="section-title">Execution audit <button className="icon-button" onClick={onClose}>×</button></div>{entries.length === 0 ? <p className="muted">No executed statements yet.</p> : <div className="history-list">{entries.map(entry => <div className="history-entry audit-entry" key={entry.id}><span><strong>{entry.status}</strong> · {entry.commandType} · {new Date(entry.createdAt).toLocaleString()} · {entry.database}</span><code>{entry.sql}</code><small>{entry.rowsAffected === undefined ? '—' : `${entry.rowsAffected.toLocaleString()} row(s) affected`} · {entry.durationMs} ms · {entry.confirmed ? 'confirmed' : 'read-only'}</small></div>)}</div>}</section></div>;
}

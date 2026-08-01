import { useEffect, useMemo, useState } from 'react';

import { useCloudLibrary } from '../../state/CloudLibraryContext.jsx';

function messageFor(error, fallback) {
  if (error?.code === 'last_owner_required') return 'At least one active owner is required.';
  return error?.message || fallback;
}

function PasswordChange({ library, onCancel, onDone }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async event => {
    event.preventDefault();
    setNotice('');
    const length = [...password].length;
    if (length < 12 || length > 256) {
      setNotice('Password must be 12–256 characters.');
      return;
    }
    if (password !== confirmation) {
      setNotice('Passwords do not match.');
      return;
    }
    setBusy(true);
    const result = await library.changePassword(password);
    setBusy(false);
    if (!result.ok) setNotice(messageFor(result.error, 'Password could not be changed.'));
    else {
      setPassword('');
      setConfirmation('');
      onDone?.();
    }
  };

  return (
    <form className="cloud-account-form cloud-library-guidance" onSubmit={submit}>
      <strong>Choose a new password</strong>
      <p>Replace your temporary password before opening the online library.</p>
      <label htmlFor="cloud-new-password">New password</label>
      <input id="cloud-new-password" className="pm-input" type="password" autoComplete="new-password" minLength={12} maxLength={256} value={password} onChange={event => setPassword(event.target.value)} />
      <label htmlFor="cloud-confirm-password">Confirm new password</label>
      <input id="cloud-confirm-password" className="pm-input" type="password" autoComplete="new-password" minLength={12} maxLength={256} value={confirmation} onChange={event => setConfirmation(event.target.value)} />
      <div className="set-actions">
        {onCancel && <button type="button" className="btn" disabled={busy} onClick={onCancel}>Cancel</button>}
        <button type="submit" className="btn primary" disabled={busy}>Change password</button>
      </div>
      {notice && <p className="cloud-account-error" role="alert">{notice}</p>}
    </form>
  );
}

function OwnerAccounts({ library }) {
  const [accounts, setAccounts] = useState([]);
  const [assignments, setAssignments] = useState({});
  const [form, setForm] = useState({ username: '', displayName: '', role: 'worker', temporaryPassword: '' });
  const [resetPasswords, setResetPasswords] = useState({});
  const [assignmentProjects, setAssignmentProjects] = useState({});
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');

  const load = async () => {
    const result = await library.listAccounts();
    if (!result.ok) {
      setNotice(messageFor(result.error, 'Accounts could not be loaded.'));
      return;
    }
    setAccounts(result.value);
    const entries = await Promise.all(result.value.map(async account => {
      const assigned = await library.listAssignments(account.id);
      return [account.id, assigned.ok ? assigned.value : []];
    }));
    setAssignments(Object.fromEntries(entries));
  };

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (key, action, success) => {
    setBusy(key);
    setNotice('');
    const result = await action();
    setBusy('');
    if (!result.ok) {
      setNotice(messageFor(result.error, 'The account action could not be completed.'));
      return false;
    }
    await load();
    if (success) setNotice(success);
    return true;
  };

  const create = async event => {
    event.preventDefault();
    const succeeded = await run('create', () => library.createAccount(form), `Created @${form.username}.`);
    if (succeeded) setForm({ username: '', displayName: '', role: 'worker', temporaryPassword: '' });
  };

  const reset = async account => {
    const password = resetPasswords[account.id] || '';
    const succeeded = await run(`reset-${account.id}`, () => library.resetAccountPassword(account.id, password), `Reset @${account.username}’s password.`);
    if (succeeded) setResetPasswords(current => ({ ...current, [account.id]: '' }));
  };

  const assign = async account => {
    const projectId = assignmentProjects[account.id];
    if (!projectId) return;
    await run(`assign-${account.id}`, () => library.assignProject(account.id, projectId), `Assigned a draft to @${account.username}.`);
  };

  return (
    <section className="cloud-account-admin" aria-labelledby="cloud-account-admin-title">
      <div>
        <span className="cloud-kicker">Owner controls</span>
        <h4 id="cloud-account-admin-title">Accounts</h4>
      </div>
      <form className="cloud-account-create" onSubmit={create}>
        <input className="pm-input" aria-label="New account username" placeholder="Username" required minLength={3} maxLength={64} value={form.username} onChange={event => setForm(current => ({ ...current, username: event.target.value }))} />
        <input className="pm-input" aria-label="New account display name" placeholder="Display name" required maxLength={80} value={form.displayName} onChange={event => setForm(current => ({ ...current, displayName: event.target.value }))} />
        <select className="pm-input" aria-label="New account role" value={form.role} onChange={event => setForm(current => ({ ...current, role: event.target.value }))}>
          <option value="worker">Worker</option>
          <option value="customer">Customer</option>
        </select>
        <input className="pm-input" aria-label="Temporary password" type="password" autoComplete="new-password" placeholder="Temporary password" required minLength={12} maxLength={256} value={form.temporaryPassword} onChange={event => setForm(current => ({ ...current, temporaryPassword: event.target.value }))} />
        <button type="submit" className="btn primary" disabled={busy === 'create'}>Create account</button>
      </form>
      <div className="cloud-account-table-wrap">
        <table className="cloud-account-table">
          <thead><tr><th>Account</th><th>Role</th><th>Status</th><th>Access</th></tr></thead>
          <tbody>{accounts.map(account => {
            const isSelf = account.username === library.session.username;
            const accountAssignments = assignments[account.id] || [];
            const assignedIds = new Set(accountAssignments.map(assignment => assignment.projectId));
            const available = library.activeProjects.filter(project => !assignedIds.has(project.id));
            return (
              <tr key={account.id} data-testid="account-row">
                <td><strong>{account.displayName}</strong><span>@{account.username}</span></td>
                <td>
                  <select className="pm-input" aria-label={`Role for ${account.username}`} disabled={isSelf || busy === `role-${account.id}`} value={account.role} onChange={event => run(`role-${account.id}`, () => library.setAccountRole(account.id, event.target.value), `Updated @${account.username}’s role.`)}>
                    <option value="owner">Owner</option><option value="worker">Worker</option><option value="customer">Customer</option>
                  </select>
                </td>
                <td><span className={`cloud-account-status is-${account.status}`}>{account.status}</span></td>
                <td>
                  <div className="cloud-account-actions">
                    {isSelf ? <span>Use Change Password for your own account.</span> : <>
                      <input className="pm-input" aria-label={`Reset password for ${account.username}`} type="password" autoComplete="new-password" minLength={12} maxLength={256} placeholder="New temporary password" value={resetPasswords[account.id] || ''} onChange={event => setResetPasswords(current => ({ ...current, [account.id]: event.target.value }))} />
                      <button type="button" className="btn ghost-sm" disabled={(resetPasswords[account.id] || '').length < 12 || busy === `reset-${account.id}`} onClick={() => reset(account)}>Reset password</button>
                    </>}
                    <button type="button" className="btn ghost-sm" disabled={isSelf || busy === `status-${account.id}`} onClick={() => run(`status-${account.id}`, () => library.setAccountStatus(account.id, account.status === 'active' ? 'disabled' : 'active'), `${account.status === 'active' ? 'Disabled' : 'Enabled'} @${account.username}.`)}>{account.status === 'active' ? 'Disable' : 'Enable'}</button>
                    {(account.role === 'customer' || accountAssignments.length > 0) && (
                      <div className="cloud-assignments">
                        {accountAssignments.map(assignment => <span key={assignment.projectId}>{assignment.project.officialTitle}<button type="button" className="btn ghost-sm" aria-label={`Unassign ${assignment.project.officialTitle} from ${account.username}`} onClick={() => run(`unassign-${account.id}-${assignment.projectId}`, () => library.unassignProject(account.id, assignment.projectId), `Unassigned ${assignment.project.officialTitle}.`)}>Unassign</button></span>)}
                        {account.role === 'customer' && account.status === 'active' && available.length > 0 && <div className="cloud-assignment-create"><select className="pm-input" aria-label={`Project for ${account.username}`} value={assignmentProjects[account.id] || ''} onChange={event => setAssignmentProjects(current => ({ ...current, [account.id]: event.target.value }))}><option value="">Assign project…</option>{available.map(project => <option value={project.id} key={project.id}>{project.title}</option>)}</select><button type="button" className="btn ghost-sm" disabled={!assignmentProjects[account.id]} onClick={() => assign(account)}>Assign</button></div>}
                      </div>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
      {notice && <p className="cloud-library-notice" role="status">{notice}</p>}
    </section>
  );
}

export function AccountAccessPanel() {
  const library = useCloudLibrary();
  const [login, setLogin] = useState({ username: '', password: '' });
  const [bootstrap, setBootstrap] = useState({ username: '', displayName: '', temporaryPassword: '' });
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const authenticated = library.session.status === 'authenticated';
  const sessionBoundary = `${library.session.status}:${library.session.username || library.session.email || ''}:${library.session.role || ''}:${library.session.mustChangePassword ? 'forced' : 'ready'}`;
  const nativeOwner = authenticated && library.session.role === 'owner' && Boolean(library.session.username);
  const roleLabel = useMemo(() => library.session.role ? `${library.session.role[0].toUpperCase()}${library.session.role.slice(1)}` : '', [library.session.role]);

  useEffect(() => {
    setLogin({ username: '', password: '' });
    setBootstrap({ username: '', displayName: '', temporaryPassword: '' });
    setNotice('');
    setBusy(false);
    setChangingPassword(false);
  }, [sessionBoundary]);

  const signIn = async event => {
    event.preventDefault();
    setBusy(true);
    setNotice('');
    const result = await library.login(login);
    setBusy(false);
    if (!result.ok) setNotice(result.error?.code === 'invalid_credentials' ? 'Invalid username or password.' : 'Sign in could not be completed.');
    else setLogin({ username: '', password: '' });
  };

  const createOwner = async event => {
    event.preventDefault();
    setBusy(true);
    setNotice('');
    const result = await library.bootstrapOwner(bootstrap);
    setBusy(false);
    if (!result.ok) setNotice(messageFor(result.error, 'Owner account could not be created.'));
    else setBootstrap({ username: '', displayName: '', temporaryPassword: '' });
  };

  if (library.session.status === 'loading') return <p role="status">Checking online library access…</p>;
  if (library.session.status === 'password-change') return <PasswordChange key={sessionBoundary} library={library} />;
  if (library.session.status === 'bootstrap') return (
    <form className="cloud-account-form cloud-library-guidance" onSubmit={createOwner}>
      <strong>Create owner account</strong><p>Create the first Lightweaver owner login for this library.</p>
      <label htmlFor="bootstrap-username">Username</label><input id="bootstrap-username" className="pm-input" required minLength={3} maxLength={64} value={bootstrap.username} onChange={event => setBootstrap(current => ({ ...current, username: event.target.value }))} />
      <label htmlFor="bootstrap-display-name">Display name</label><input id="bootstrap-display-name" className="pm-input" required maxLength={80} value={bootstrap.displayName} onChange={event => setBootstrap(current => ({ ...current, displayName: event.target.value }))} />
      <label htmlFor="bootstrap-password">Temporary password</label><input id="bootstrap-password" className="pm-input" type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={bootstrap.temporaryPassword} onChange={event => setBootstrap(current => ({ ...current, temporaryPassword: event.target.value }))} />
      <button type="submit" className="btn primary" disabled={busy}>Create owner account</button>
      {notice && <p className="cloud-account-error" role="alert">{notice}</p>}
    </form>
  );
  if (!authenticated) return (
    <form className="cloud-account-form cloud-library-guidance" onSubmit={signIn}>
      <strong>{library.session.status === 'error' ? 'The online library is unavailable' : 'Sign in to use the online project library'}</strong>
      <label htmlFor="cloud-login-username">Username</label><input id="cloud-login-username" className="pm-input" autoComplete="username" required maxLength={64} value={login.username} onChange={event => setLogin(current => ({ ...current, username: event.target.value }))} />
      <label htmlFor="cloud-login-password">Password</label><input id="cloud-login-password" className="pm-input" type="password" autoComplete="current-password" required maxLength={256} value={login.password} onChange={event => setLogin(current => ({ ...current, password: event.target.value }))} />
      <button type="submit" className="btn primary" disabled={busy}>Sign in</button>
      {library.session.status === 'error' && <button type="button" className="btn" onClick={library.retrySession}>Try again</button>}
      {notice && <p className="cloud-account-error" role="alert">{notice}</p>}
    </form>
  );

  return (
    <>
      <div className="cloud-account-session">
        <div className="cloud-identity"><strong>{library.session.displayName}</strong><span>@{library.session.username}</span><span>{roleLabel}</span></div>
        <button type="button" className="btn ghost-sm" onClick={() => setChangingPassword(true)}>Change password</button>
        <button type="button" className="btn ghost-sm" onClick={library.logout}>Sign out</button>
      </div>
      {changingPassword && <PasswordChange key={`personal:${sessionBoundary}`} library={library} onCancel={() => setChangingPassword(false)} onDone={() => setChangingPassword(false)} />}
      {nativeOwner && <OwnerAccounts key={sessionBoundary} library={library} />}
    </>
  );
}

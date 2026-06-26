import { useEffect, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { Api, ApiError, type ManagedUser } from '../lib/api';
import { useAuth } from '../lib/auth';

/**
 * Admin-only user management.
 *
 * Lists every user with their roles + active state, lets an admin add a user
 * (email + display name + admin-set initial password + role checkboxes), edit a
 * user's roles, and activate/deactivate. Server enforces the same admin gate
 * and the last-admin lockout guards — this page surfaces those errors inline.
 */

// Roles are fetched from /api/roles so client shells can define custom ones.
// Seed with admin so the UI renders before the fetch completes.
const DEFAULT_ROLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'admin', label: 'Admin' },
];

const ERROR_LABELS: Record<string, string> = {
  email_taken: 'A user with that email already exists.',
  last_admin: 'Refused: that would leave no active admin.',
  invalid_input: 'Check the fields and try again.',
  forbidden: 'You do not have permission to do that.',
};

function errLabel(e: unknown): string {
  if (e instanceof ApiError) return ERROR_LABELS[e.message] ?? e.message;
  return 'Something went wrong.';
}

export function Users(): JSX.Element {
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [roleOptions, setRoleOptions] = useState(DEFAULT_ROLE_OPTIONS);
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    setError(null);
    try {
      const [usersRes, rolesRes] = await Promise.all([Api.listUsers(), Api.getRoles()]);
      setUsers(usersRes.users);
      setRoleOptions(rolesRes.roles);
    } catch (e) {
      setError(errLabel(e));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div>
      <PageHeader
        title="Users"
        description="Add operators, assign roles, and activate or deactivate accounts."
      />
      <div className="mx-auto max-w-4xl space-y-6 p-6 sm:p-8">
        <AddUserForm onCreated={load} roleOptions={roleOptions} />

        <section className="card p-6">
          <h2 className="section-heading mb-4">All users</h2>
          {error && <div className="mb-3 text-sm text-bad">{error}</div>}
          {users === null ? (
            <div className="text-sm text-ink-500 dark:text-ink-400">Loading…</div>
          ) : users.length === 0 ? (
            <div className="text-sm text-ink-500 dark:text-ink-400">No users yet.</div>
          ) : (
            <div className="space-y-3">
              {users.map((u) => (
                <UserRow key={u.id} user={u} onChanged={load} roleOptions={roleOptions} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function AddUserForm(props: { onCreated: () => Promise<void>; roleOptions: Array<{ value: string; label: string }> }): JSX.Element {
  const { roleOptions } = props;
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [roles, setRoles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const toggleRole = (role: string): void => {
    setRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role],
    );
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setOk(false);
    if (password.length < 12) {
      setError('Password must be at least 12 characters.');
      return;
    }
    setBusy(true);
    try {
      await Api.createUser({
        email: email.trim(),
        displayName: displayName.trim() || undefined,
        password,
        roles,
      });
      setEmail('');
      setDisplayName('');
      setPassword('');
      setRoles([]);
      setOk(true);
      await props.onCreated();
    } catch (e2) {
      setError(errLabel(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card p-6">
      <h2 className="section-heading mb-4">Add a user</h2>
      {/* autocomplete="off" + a decoy hidden field defends against browser
          autofill leaking the admin's own saved credentials into a new-user
          form. The password field is autoComplete="new-password" per policy. */}
      <form onSubmit={submit} autoComplete="off">
        {/* Decoy fields: some browsers ignore autocomplete=off but will fill
            the first username/password pair they find — sacrifice these. */}
        <input
          type="text"
          name="prevent_autofill_username"
          autoComplete="username"
          className="hidden"
          tabIndex={-1}
          aria-hidden="true"
        />
        <input
          type="password"
          name="prevent_autofill_password"
          autoComplete="new-password"
          className="hidden"
          tabIndex={-1}
          aria-hidden="true"
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="new-user-email">
              Email
            </label>
            <input
              id="new-user-email"
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="off"
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="new-user-name">
              Display name
            </label>
            <input
              id="new-user-name"
              type="text"
              className="input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div>
            <label className="label" htmlFor="new-user-password">
              Initial password
            </label>
            <input
              id="new-user-password"
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={12}
              required
            />
            <p className="mt-1 text-xs text-ink-500 dark:text-ink-400">
              12+ characters. Share it with the user out-of-band — there is no
              email invite.
            </p>
          </div>
          <div>
            <span className="label">Roles</span>
            <div className="mt-1 flex flex-col gap-1.5">
              {roleOptions.map((r) => (
                <label key={r.value} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={roles.includes(r.value)}
                    onChange={() => toggleRole(r.value)}
                  />
                  {r.label}
                </label>
              ))}
            </div>
          </div>
        </div>
        {error && <div className="mt-3 text-sm text-bad">{error}</div>}
        {ok && <div className="mt-3 text-sm text-ink-500 dark:text-ink-400">User created.</div>}
        <div className="mt-4">
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Add user'}
          </button>
        </div>
      </form>
    </section>
  );
}

function UserRow(props: { user: ManagedUser; onChanged: () => Promise<void>; roleOptions: Array<{ value: string; label: string }> }): JSX.Element {
  const { roleOptions } = props;
  const { user } = props;
  const { state } = useAuth();
  const isSelf = state.kind === 'authenticated' && state.user.id === user.id;
  const [roles, setRoles] = useState<string[]>(user.roles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep local role state in sync if the parent reloads with new data.
  useEffect(() => {
    setRoles(user.roles);
  }, [user.roles]);

  const dirty =
    roles.length !== user.roles.length ||
    roles.some((r) => !user.roles.includes(r));

  const toggleRole = (role: string): void => {
    setRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role],
    );
  };

  const saveRoles = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await Api.setUserRoles(user.id, roles);
      await props.onChanged();
    } catch (e) {
      setError(errLabel(e));
      setRoles(user.roles); // revert on failure
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await Api.updateUser(user.id, { isActive: !user.isActive });
      await props.onChanged();
    } catch (e) {
      setError(errLabel(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-ink-200 p-4 dark:border-ink-700">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-ink-900 dark:text-ink-100">
              {user.email}
            </span>
            {user.isActive ? (
              <span className="pill-ok">active</span>
            ) : (
              <span className="pill-bad">inactive</span>
            )}
            {isSelf && <span className="pill">you</span>}
          </div>
          {user.displayName && (
            <div className="mt-0.5 text-xs text-ink-500 dark:text-ink-400">
              {user.displayName}
            </div>
          )}
        </div>
        <button
          className={user.isActive ? 'btn-danger' : 'btn-secondary'}
          disabled={busy}
          onClick={toggleActive}
        >
          {user.isActive ? 'Deactivate' : 'Activate'}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4">
        {roleOptions.map((r) => (
          <label key={r.value} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={roles.includes(r.value)}
              onChange={() => toggleRole(r.value)}
              disabled={busy}
            />
            {r.label}
          </label>
        ))}
        <button className="btn-secondary" disabled={!dirty || busy} onClick={saveRoles}>
          {busy ? 'Saving…' : 'Save roles'}
        </button>
      </div>

      {error && <div className="mt-2 text-sm text-bad">{error}</div>}
    </div>
  );
}

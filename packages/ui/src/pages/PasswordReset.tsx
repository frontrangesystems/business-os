import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

/**
 * Two anonymous routes in one file:
 *
 *   /reset/request  — operator submits their email; server sends a token via
 *                     the configured system-email connector. UI always shows
 *                     a generic "check your inbox" message — never confirms
 *                     whether the email is on file.
 *   /reset          — operator pastes the token (from email link or server
 *                     log in dev) + a new password.
 *
 * Until the system-email connector ships, dev operators copy the token from
 * the server's log line (Pino INFO `issued password reset token`).
 */

export function PasswordResetRequest(): JSX.Element {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError(null);
    try {
      await api('/auth/password-reset/request', {
        method: 'POST',
        body: { email },
      });
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'request failed');
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-50 px-4 dark:bg-ink-950">
      <form onSubmit={onSubmit} className="card w-full max-w-sm space-y-5 p-8 shadow">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">Reset your password</h1>
          <p className="mt-1 text-sm text-ink-500 dark:text-ink-400">
            Enter your email; if we have it on file we'll send a reset link.
          </p>
        </header>

        {submitted ? (
          <div className="rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900 dark:border-green-800 dark:bg-green-900/30 dark:text-green-200">
            If <span className="font-mono">{email}</span> matches an account, a
            reset link is on its way. Check your inbox.
          </div>
        ) : (
          <>
            <div>
              <label htmlFor="email" className="label">
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input"
                required
                autoFocus
              />
            </div>
            {error && (
              <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200">
                {error}
              </div>
            )}
            <button className="btn-primary w-full" type="submit">
              Send reset link
            </button>
          </>
        )}

        <div className="text-center text-xs text-ink-500 dark:text-ink-400">
          <Link to="/login" className="text-accent hover:underline">
            Back to sign in
          </Link>
        </div>
      </form>
    </div>
  );
}

export function PasswordResetComplete(): JSX.Element {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    if (password.length < 12) {
      setError('Password must be at least 12 characters.');
      return;
    }
    setSubmitting(true);
    try {
      await api('/auth/password-reset/complete', {
        method: 'POST',
        body: { token, password },
      });
      // Server revokes all sessions on reset. Refresh auth state to anonymous
      // before navigating so the Login page doesn't redirect already-authenticated users.
      await refresh();
      navigate('/login', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.message === 'invalid_or_expired_token') {
          setError('That link is no longer valid. Request a new one.');
        } else {
          setError(err.message);
        }
      } else {
        setError('Reset failed.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-50 px-4 dark:bg-ink-950">
      <form onSubmit={onSubmit} className="card w-full max-w-sm space-y-5 p-8 shadow">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">Set a new password</h1>
          <p className="mt-1 text-sm text-ink-500 dark:text-ink-400">
            Enter the token from your email and choose a new password (12+ characters).
          </p>
        </header>

        <div>
          <label htmlFor="password" className="label">
            New password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            className="input"
            required
            minLength={12}
          />
        </div>

        <div>
          <label htmlFor="confirm" className="label">
            Confirm new password
          </label>
          <input
            id="confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            className="input"
            required
            minLength={12}
          />
        </div>

        {error && (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200">
            {error}
          </div>
        )}

        <button className="btn-primary w-full" type="submit" disabled={submitting}>
          {submitting ? 'Resetting…' : 'Reset password'}
        </button>

        <div className="text-center text-xs text-ink-500 dark:text-ink-400">
          <Link to="/login" className="text-accent hover:underline">
            Back to sign in
          </Link>
        </div>
      </form>
    </div>
  );
}

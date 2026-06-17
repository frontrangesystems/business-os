import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Api, ApiError } from './api';

type User = { id: string; email: string; roles: string[]; displayName?: string | null };
type State =
  | { kind: 'loading' }
  | { kind: 'anonymous' }
  | { kind: 'authenticated'; user: User; totpEnrolled: boolean };

interface AuthCtx {
  state: State;
  /** True iff the authenticated user holds the 'admin' role. */
  isAdmin: boolean;
  refresh: () => Promise<void>;
  login: (email: string, password: string, totp?: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const refresh = async (): Promise<void> => {
    try {
      const me = await Api.me();
      if (me.user) {
        setState({
          kind: 'authenticated',
          user: { ...me.user, roles: me.user.roles ?? [] },
          totpEnrolled: me.totpEnrolled ?? false,
        });
      } else {
        setState({ kind: 'anonymous' });
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setState({ kind: 'anonymous' });
      } else {
        // Network/parsing error — surface as anonymous; the API page handles its own errors.
        setState({ kind: 'anonymous' });
      }
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const login: AuthCtx['login'] = async (email, password, totp) => {
    await Api.login(email, password, totp);
    await refresh();
  };
  const logout: AuthCtx['logout'] = async () => {
    await Api.logout();
    setState({ kind: 'anonymous' });
  };

  const isAdmin =
    state.kind === 'authenticated' && state.user.roles.includes('admin');

  return (
    <Ctx.Provider value={{ state, isAdmin, refresh, login, logout }}>{children}</Ctx.Provider>
  );
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside of AuthProvider');
  return v;
}

/**
 * Route guard: renders children only for admins. Non-admins are redirected to
 * the dashboard. Must sit inside RequireAuth (it assumes an authenticated user;
 * a still-loading auth state renders nothing rather than flashing a redirect).
 */
export function RequireAdmin({ children }: { children: ReactNode }): JSX.Element {
  const { state, isAdmin } = useAuth();
  if (state.kind === 'loading') {
    return <div className="flex h-full items-center justify-center text-ink-400">…</div>;
  }
  if (!isAdmin) {
    return <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}

export function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const { state } = useAuth();
  const loc = useLocation();
  if (state.kind === 'loading') {
    return <div className="flex h-full items-center justify-center text-ink-400">…</div>;
  }
  if (state.kind === 'anonymous') {
    return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  }
  return <>{children}</>;
}

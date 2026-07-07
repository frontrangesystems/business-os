import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useBranding } from '../lib/branding';
import { Api, type WireAudience } from '../lib/api';

interface ModuleNav {
  slug: string;
  displayName: string;
  defaultAudience?: WireAudience;
  pages: Array<{ path: string; navLabel?: string; audience?: WireAudience }>;
}

/**
 * AudienceTag enforcement (nav side): a page/module is admin-only iff its
 * effective audience is {kind:'admins'} — per-page audience wins, falling back
 * to the module's defaultAudience, falling back to everyone. Non-admins never
 * see admin-only nav entries (the route is also guarded; see app.tsx).
 */
function isVisibleTo(
  effective: WireAudience | undefined,
  isAdmin: boolean,
): boolean {
  if (effective?.kind === 'admins') return isAdmin;
  return true; // everyone (default) or unknown
}

const NAV_OPEN_KEY = 'businessos.nav.open';

function readNavOpen(): boolean {
  try {
    // Default open; only a stored 'false' collapses the sidebar on load.
    return window.localStorage.getItem(NAV_OPEN_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function Shell(): JSX.Element {
  const { state, isAdmin, logout } = useAuth();
  const branding = useBranding();
  const navigate = useNavigate();
  const user = state.kind === 'authenticated' ? state.user : null;
  const [modules, setModules] = useState<ModuleNav[]>([]);
  const [navOpen, setNavOpen] = useState<boolean>(readNavOpen);

  useEffect(() => {
    try {
      window.localStorage.setItem(NAV_OPEN_KEY, String(navOpen));
    } catch {
      // localStorage unavailable (private mode / SSR) — collapse state just
      // won't persist, which is fine.
    }
  }, [navOpen]);

  useEffect(() => {
    if (state.kind !== 'authenticated') return;
    Api.listModules()
      .then((r) =>
        setModules(
          r.modules.map((m) => ({
            slug: m.slug,
            displayName: m.displayName,
            defaultAudience: m.defaultAudience,
            pages: m.uiPages,
          })),
        ),
      )
      .catch(() => {
        // /api/modules may not exist on older cores or when no modules are wired.
        setModules([]);
      });
  }, [state.kind]);

  // Filter module nav by AudienceTag. A module is hidden entirely when admin-only
  // and the user isn't an admin; otherwise individual pages are filtered.
  const visibleModules = modules
    .filter((m) => isVisibleTo(m.defaultAudience, isAdmin))
    .map((m) => ({
      ...m,
      pages: m.pages.filter((p) =>
        isVisibleTo(p.audience ?? m.defaultAudience, isAdmin),
      ),
    }));

  return (
    <div className="flex h-full min-h-screen bg-ink-50 text-ink-900 dark:bg-ink-950 dark:text-ink-100">
      <aside
        className={`shrink-0 overflow-hidden border-r border-ink-200 bg-white transition-[width] duration-300 ease-in-out dark:border-ink-800 dark:bg-ink-900 ${
          navOpen ? 'w-60' : 'w-0 border-r-0'
        }`}
      >
        {/* Fixed inner width so labels don't reflow while the rail animates. */}
        <div className="flex h-full w-60 flex-col">
        <div
          className={
            branding?.headerBackground === 'dark'
              ? 'border-b border-ink-800 bg-ink-900 px-5 py-4 text-ink-50'
              : branding?.headerBackground === 'light'
                ? 'border-b border-ink-200 bg-white px-5 py-4 text-ink-900'
                : 'border-b border-ink-200 px-5 py-4 dark:border-ink-800'
          }
        >
          {branding?.logoUrl && (
            <img
              src={branding.logoUrl}
              alt={branding.businessName}
              className={
                // Monochrome logos flip with the theme so they always
                // contrast with the header background.
                branding.logoTone === 'light'
                  ? 'mb-2 h-8 w-auto invert dark:invert-0'
                  : branding.logoTone === 'dark'
                    ? 'mb-2 h-8 w-auto dark:invert'
                    : 'mb-2 h-8 w-auto'
              }
            />
          )}
          <div className="text-sm font-semibold tracking-tight">
            {branding?.businessName ?? 'Business OS'}
          </div>
          <div
            className={
              branding?.headerBackground === 'dark'
                ? 'mt-0.5 text-xs text-ink-400'
                : 'mt-0.5 text-xs text-ink-500 dark:text-ink-400'
            }
          >
            {branding?.businessName ? 'Business OS' : 'Operator console'}
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 p-3 text-sm">
          <NavItem to="/dashboard">Dashboard</NavItem>
          <NavItem to="/agents">Agents</NavItem>
          {/* Connectors/Providers are an admin-only area — all writes there are
              requireRole('admin')-gated server-side, so hide the nav entry from
              non-admins (the route is guarded too). */}
          {isAdmin && <NavItem to="/connectors">Connectors</NavItem>}
          {visibleModules.length > 0 && <SidebarLabel>Modules</SidebarLabel>}
          {visibleModules.map((m) =>
            m.pages.length === 0 ? (
              <NavItem key={m.slug} to={`/modules/${m.slug}`}>
                {m.displayName}
              </NavItem>
            ) : (
              m.pages
                .filter((p) => p.navLabel)
                .map((p) => (
                  <NavItem
                    key={`${m.slug}-${p.path}`}
                    to={`/modules/${m.slug}${p.path ? '/' + p.path : ''}`}
                  >
                    {p.navLabel}
                  </NavItem>
                ))
            ),
          )}
          <SidebarLabel>Operator</SidebarLabel>
          <NavItem to="/audit">Audit log</NavItem>
          {isAdmin && <NavItem to="/users">Users</NavItem>}
          <NavItem to="/settings">Account</NavItem>
        </nav>
        <div className="border-t border-ink-200 px-5 py-4 text-xs text-ink-500 dark:border-ink-800 dark:text-ink-400">
          <div className="truncate font-mono">{user?.email ?? '—'}</div>
          <button
            className="mt-2 text-accent transition-colors hover:text-accent-hover hover:underline"
            onClick={async () => {
              await logout();
              navigate('/login');
            }}
          >
            Sign out
          </button>
        </div>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-ink-200 bg-white/80 px-4 py-3 backdrop-blur dark:border-ink-800 dark:bg-ink-900/80">
          <button
            type="button"
            onClick={() => setNavOpen((o) => !o)}
            aria-label={navOpen ? 'Collapse menu' : 'Open menu'}
            aria-expanded={navOpen}
            className="rounded-md p-2 text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-900 dark:text-ink-300 dark:hover:bg-ink-800 dark:hover:text-ink-100"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          {!navOpen && (
            <span className="truncate text-sm font-semibold tracking-tight">
              {branding?.businessName ?? 'Business OS'}
            </span>
          )}
        </header>
        <div className="flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function NavItem({ to, children }: { to: string; children: React.ReactNode }): JSX.Element {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `rounded-md px-3 py-2 transition-colors ${
          isActive
            ? 'bg-accent/10 font-medium text-accent dark:bg-accent/20'
            : 'text-ink-600 hover:bg-ink-50 hover:text-ink-900 dark:text-ink-300 dark:hover:bg-ink-800 dark:hover:text-ink-100'
        }`
      }
    >
      {children}
    </NavLink>
  );
}

function SidebarLabel({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="mt-4 px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-ink-400 dark:text-ink-500">
      {children}
    </div>
  );
}

import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Login } from './pages/Login';
import { PasswordResetRequest, PasswordResetComplete } from './pages/PasswordReset';
import { Shell } from './components/Shell';
import { Dashboard } from './pages/Dashboard';
import { AgentsList } from './pages/AgentsList';
import { AgentDetail } from './pages/AgentDetail';
import { RunDetail } from './pages/RunDetail';
import { ConnectorsPage } from './pages/ConnectorsPage';
import { ModulesAdmin } from './pages/ModulesAdmin';
import { AuditPage } from './pages/AuditPage';
import { ModulePagePlaceholder } from './pages/ModulePagePlaceholder';
import { NotFound } from './pages/NotFound';
import { Settings } from './pages/Settings';
import { Users } from './pages/Users';
import { AuthProvider, RequireAuth, RequireAdmin } from './lib/auth';
import { ThemeProvider } from './lib/theme';
import { ToastProvider } from './lib/toast';
import { BrandingProvider, type Branding } from './lib/branding';
import type { ModuleUiPage } from '@frontrangesystems/business-os-module-sdk';

/**
 * Per-module UI bundle. A client shell that wants module pages to render
 * passes one entry per registered module here.
 */
export interface ModuleUiBundle {
  /** Module slug — matches the one in business-os.config's registerModule call. */
  slug: string;
  /** UI pages exported by the module package's ./ui entry point. */
  pages: ModuleUiPage[];
}

export interface CreateOperatorAppOptions {
  /**
   * UI bundles for installed modules. Each bundle contributes routes under
   * /modules/<slug>/<page.path>. When omitted, /modules/:slug/* falls back
   * to a placeholder that explains how to wire it up.
   */
  modules?: ModuleUiBundle[];
  /**
   * Per-install branding (business name + logo). When omitted the shell
   * falls back to a generic "Business OS" header. See `./lib/branding`.
   */
  branding?: Branding;
}

/**
 * Build the operator app. Two consumers:
 *   1. @frontrangesystems/business-os-ui's own main.tsx (default no-module bundle served by core).
 *   2. A client shell's own UI entry that imports its modules and passes them
 *      in via `modules`.
 *
 * The shell-owned build replaces the default bundle when core's ui-serve finds
 * a `dist-ui/` directory in the shell's package root.
 */
export function createOperatorApp(options: CreateOperatorAppOptions = {}): {
  mount: (el: HTMLElement) => Root;
} {
  const modules = options.modules ?? [];
  const branding = options.branding ?? null;

  return {
    mount(el): Root {
      const root = createRoot(el);
      root.render(
        <StrictMode>
          <BrowserRouter>
            <ToastProvider>
              <ThemeProvider>
              <BrandingProvider value={branding}>
              <AuthProvider>
                <Routes>
                  <Route path="/login" element={<Login />} />
                  <Route path="/reset/request" element={<PasswordResetRequest />} />
                  <Route path="/reset" element={<PasswordResetComplete />} />
                  <Route
                    path="/"
                    element={
                      <RequireAuth>
                        <Shell />
                      </RequireAuth>
                    }
                  >
                    <Route index element={<Navigate to="/dashboard" replace />} />
                    <Route path="dashboard" element={<Dashboard />} />
                    <Route path="agents" element={<AgentsList />} />
                    <Route path="agents/:slug" element={<AgentDetail />} />
                    <Route path="runs/:id" element={<RunDetail />} />
                    {/* Connectors/Providers is an admin-only area. */}
                    <Route
                      path="connectors"
                      element={
                        <RequireAdmin>
                          <ConnectorsPage />
                        </RequireAdmin>
                      }
                    />
                    {/* /providers used to be its own page; it's now a tab on
                        /connectors. Redirect to preserve any saved bookmarks. */}
                    <Route path="providers" element={<Navigate to="/connectors?tab=available" replace />} />
                    <Route path="audit" element={<AuditPage />} />
                    {/* User management — admin only (route guard mirrors the
                        server's requireRole('admin') gate). */}
                    <Route
                      path="users"
                      element={
                        <RequireAdmin>
                          <Users />
                        </RequireAdmin>
                      }
                    />
                    <Route path="settings" element={<Settings />} />
                    {/* Module configuration (settings + connector bindings) —
                        admin only, mirrors the server's requireRole('admin'). */}
                    <Route
                      path="modules-admin"
                      element={
                        <RequireAdmin>
                          <ModulesAdmin />
                        </RequireAdmin>
                      }
                    />

                    {/* Module routes — one Route per uiPage, plus a per-module
                        index fallback so /modules/<slug> with no pages still
                        works. */}
                    {modules.flatMap((m) =>
                      m.pages.map((p) => {
                        // AudienceTag enforcement (route side): a page declaring
                        // audience {kind:'admins'} is guarded so a non-admin who
                        // deep-links to it is bounced to the dashboard. Anything
                        // else (everyone/departments/unknown) renders for all.
                        const element =
                          p.audience?.kind === 'admins' ? (
                            <RequireAdmin>
                              <p.Component />
                            </RequireAdmin>
                          ) : (
                            <p.Component />
                          );
                        return (
                          <Route
                            key={`${m.slug}/${p.path}`}
                            path={`modules/${m.slug}${p.path ? '/' + p.path : ''}`}
                            element={element}
                          />
                        );
                      }),
                    )}

                    {/* Anything not matched by a module's own routes (e.g. the
                        module is registered server-side but didn't ship UI
                        pages in this build) renders the placeholder. */}
                    <Route path="modules/:slug/*" element={<ModulePagePlaceholder />} />
                    <Route path="*" element={<NotFound />} />
                  </Route>
                </Routes>
              </AuthProvider>
              </BrandingProvider>
              </ThemeProvider>
            </ToastProvider>
          </BrowserRouter>
        </StrictMode>,
      );
      return root;
    },
  };
}

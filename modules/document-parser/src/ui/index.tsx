import { useEffect, useRef, useState } from 'react';
import type { ModuleUiPage } from '@frontrangesystems/business-os-module-sdk';

/**
 * UI half of @frontrangesystems/business-os-module-document-parser.
 *
 *   - Home (path ''): upload a PDF, list documents with status, open one to see
 *     its extracted takeoff (editable quantity) + export CSV.
 *   - Search (path 'search'): full-text search across every parsed page.
 */

interface DocumentRow {
  id: string;
  originalFilename: string;
  status: 'uploaded' | 'parsing' | 'parsed' | 'failed';
  pageCount: number | null;
  title: string | null;
  suggestedTitle: string | null;
  jurisdiction: string | null;
  costUsd: number | null;
  uploadedAt: string;
  parsedAt: string | null;
  error: string | null;
}

interface ItemRow {
  id: string;
  description: string;
  itemCode: string | null;
  unit: string | null;
  quantity: number | null;
  quantityExtracted: number | null;
  quantityOverridden: boolean;
  pageNo: number | null;
}

const API = '/api/modules/document-parser';

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const j = (await r.json()) as { message?: string; error?: string };
      msg = j.message ?? j.error ?? msg;
    } catch {
      /* keep default */
    }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

function StatusPill({ status }: { status: DocumentRow['status'] }): JSX.Element {
  const tone: Record<DocumentRow['status'], string> = {
    uploaded: 'bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-300',
    parsing: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100',
    parsed: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100',
    failed: 'bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100',
  };
  const label = status === 'parsing' ? 'parsing…' : status;
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${tone[status]}`}>{label}</span>;
}

function docLabel(d: DocumentRow): string {
  return d.title ?? d.suggestedTitle ?? d.originalFilename;
}

/** Inline-editable quantity cell. Commits on blur / Enter; extracted value shown
 * as a hint when the operator has overridden it. */
function QuantityCell({ item, documentId, onSaved }: { item: ItemRow; documentId: string; onSaved: (it: ItemRow) => void }): JSX.Element {
  const [value, setValue] = useState(item.quantity === null ? '' : String(item.quantity));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  useEffect(() => {
    setValue(item.quantity === null ? '' : String(item.quantity));
  }, [item.quantity]);

  const commit = async (): Promise<void> => {
    const trimmed = value.trim();
    const next = trimmed === '' ? null : Number(trimmed);
    if (next !== null && !Number.isFinite(next)) {
      setErr(true);
      return;
    }
    if (next === item.quantity) return;
    setBusy(true);
    setErr(false);
    try {
      const saved = await fetchJson<ItemRow>(`${API}/documents/${documentId}/items/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ quantity: next }),
      });
      onSaved(saved);
    } catch {
      setErr(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        inputMode="decimal"
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        className={`w-24 rounded border px-2 py-1 text-sm ${err ? 'border-red-500' : 'border-ink-200 dark:border-ink-700'} bg-transparent`}
      />
      {item.quantityOverridden && item.quantityExtracted !== null && (
        <span className="text-xs text-ink-500" title="Value read by the AI">
          (was {item.quantityExtracted})
        </span>
      )}
    </div>
  );
}

function DocumentDetail({ id, onBack, onDeleted }: { id: string; onBack: () => void; onDeleted: () => void }): JSX.Element {
  const [doc, setDoc] = useState<(DocumentRow & { items: ItemRow[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = async (): Promise<void> => {
    try {
      setDoc(await fetchJson<DocumentRow & { items: ItemRow[] }>(`${API}/documents/${id}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load failed');
    }
  };

  useEffect(() => {
    void reload();
  }, [id]);

  // Poll while parsing so the takeoff appears when the worker finishes.
  useEffect(() => {
    if (!doc || (doc.status !== 'parsing' && doc.status !== 'uploaded')) return;
    const t = setInterval(() => void reload(), 2500);
    return () => clearInterval(t);
  }, [doc?.status]);

  const del = async (): Promise<void> => {
    if (!confirm('Delete this document and its takeoff?')) return;
    try {
      await fetchJson(`${API}/documents/${id}`, { method: 'DELETE' });
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'delete failed');
    }
  };

  if (error) {
    return (
      <div className="p-8">
        <button type="button" onClick={onBack} className="mb-4 text-sm text-accent hover:underline">← Back</button>
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-900/30 dark:text-red-200">{error}</div>
      </div>
    );
  }
  if (!doc) return <div className="p-8 text-ink-500">Loading…</div>;

  return (
    <div className="p-8">
      <button type="button" onClick={onBack} className="mb-4 text-sm text-accent hover:underline">← All documents</button>
      <header className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="truncate text-lg font-semibold">{docLabel(doc)}</h1>
            <StatusPill status={doc.status} />
          </div>
          <p className="mt-1 text-sm text-ink-500">
            {doc.originalFilename}
            {doc.pageCount !== null && ` · ${doc.pageCount} pages`}
            {doc.jurisdiction && ` · ${doc.jurisdiction}`}
            {doc.costUsd !== null && ` · ~$${doc.costUsd.toFixed(2)} to extract`}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {doc.status === 'parsed' && doc.items.length > 0 && (
            <a href={`${API}/documents/${id}/export.csv`} className="rounded border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50 dark:border-ink-700 dark:hover:bg-ink-800">
              Export CSV
            </a>
          )}
          <button type="button" onClick={() => void del()} className="rounded border border-red-200 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-900/30">
            Delete
          </button>
        </div>
      </header>

      {doc.status === 'failed' && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-900/30 dark:text-red-200">
          Extraction failed: {doc.error ?? 'unknown error'}
        </div>
      )}

      {doc.status === 'parsing' || doc.status === 'uploaded' ? (
        <div className="card p-8 text-center text-sm text-ink-500">Extracting takeoff… this can take a few minutes for a large plan set.</div>
      ) : doc.status === 'parsed' ? (
        doc.items.length === 0 ? (
          <div className="card p-8 text-center text-sm text-ink-500">No pay-items were found in this document.</div>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500 dark:bg-ink-900">
                <tr>
                  <th className="px-3 py-2">Description</th>
                  <th className="px-3 py-2">Code</th>
                  <th className="px-3 py-2">Unit</th>
                  <th className="px-3 py-2">Quantity</th>
                  <th className="px-3 py-2">Page</th>
                </tr>
              </thead>
              <tbody>
                {doc.items.map((it) => (
                  <tr key={it.id} className="border-t border-ink-100 dark:border-ink-800">
                    <td className="px-3 py-2">{it.description}</td>
                    <td className="px-3 py-2 text-ink-600 dark:text-ink-400">{it.itemCode ?? '—'}</td>
                    <td className="px-3 py-2 text-ink-600 dark:text-ink-400">{it.unit ?? '—'}</td>
                    <td className="px-3 py-2">
                      <QuantityCell
                        item={it}
                        documentId={id}
                        onSaved={(saved) =>
                          setDoc((prev) => (prev ? { ...prev, items: prev.items.map((x) => (x.id === saved.id ? saved : x)) } : prev))
                        }
                      />
                    </td>
                    <td className="px-3 py-2 text-ink-600 dark:text-ink-400">{it.pageNo ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </div>
  );
}

export function DocumentParserHomePage(): JSX.Element {
  const [docs, setDocs] = useState<DocumentRow[] | null>(null);
  const [limit, setLimit] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = async (): Promise<void> => {
    try {
      const r = await fetchJson<{ documents: DocumentRow[]; documentLimit: number }>(`${API}/documents`);
      setDocs(r.documents);
      setLimit(r.documentLimit);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load failed');
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  // Poll the list while anything is still parsing.
  useEffect(() => {
    if (selectedId) return;
    if (!docs?.some((d) => d.status === 'parsing' || d.status === 'uploaded')) return;
    const t = setInterval(() => void reload(), 3000);
    return () => clearInterval(t);
  }, [docs, selectedId]);

  const upload = async (file: File): Promise<void> => {
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await fetchJson(`${API}/upload`, { method: 'POST', body: fd });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  if (selectedId) {
    return (
      <DocumentDetail
        id={selectedId}
        onBack={() => {
          setSelectedId(null);
          void reload();
        }}
        onDeleted={() => {
          setSelectedId(null);
          void reload();
        }}
      />
    );
  }

  const atCap = limit > 0 && (docs?.length ?? 0) >= limit;

  return (
    <div className="p-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Document Parser</h1>
          <p className="text-sm text-ink-500">
            Upload a plan set or spec PDF; we extract the takeoff (pay-items with quantity) you can review, edit, and export.
            {limit > 0 && ` Pilot limit: ${docs?.length ?? 0}/${limit} documents.`}
          </p>
        </div>
        <div>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
          <button
            type="button"
            disabled={uploading || atCap}
            onClick={() => fileRef.current?.click()}
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            title={atCap ? 'Pilot document limit reached' : undefined}
          >
            {uploading ? 'Uploading…' : 'Upload PDF'}
          </button>
        </div>
      </header>

      {error && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-900/30 dark:text-red-200">{error}</div>
      )}

      {!docs ? (
        <div className="text-ink-500">Loading…</div>
      ) : docs.length === 0 ? (
        <div className="card p-8 text-center text-sm text-ink-500">No documents yet. Upload a PDF to get started.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500 dark:bg-ink-900">
              <tr>
                <th className="px-3 py-2">Document</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Pages</th>
                <th className="px-3 py-2">Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr
                  key={d.id}
                  onClick={() => setSelectedId(d.id)}
                  className="cursor-pointer border-t border-ink-100 hover:bg-ink-50 dark:border-ink-800 dark:hover:bg-ink-800/50"
                >
                  <td className="px-3 py-2">
                    <span className="font-medium text-accent">{docLabel(d)}</span>
                  </td>
                  <td className="px-3 py-2"><StatusPill status={d.status} /></td>
                  <td className="px-3 py-2 text-ink-600 dark:text-ink-400">{d.pageCount ?? '—'}</td>
                  <td className="px-3 py-2 text-ink-600 dark:text-ink-400">{new Date(d.uploadedAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface SearchHit {
  documentId: string;
  originalFilename: string;
  title: string | null;
  suggestedTitle: string | null;
  page: number;
  snippet: string;
  rank: number;
}

/** Render a ts_headline snippet: «matched» spans become highlighted. */
function Snippet({ text }: { text: string }): JSX.Element {
  const parts = text.split(/(«[^»]*»)/g);
  return (
    <span>
      {parts.map((p, i) =>
        p.startsWith('«') && p.endsWith('»') ? (
          <mark key={i} className="rounded bg-amber-200 px-0.5 dark:bg-amber-500/40">{p.slice(1, -1)}</mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </span>
  );
}

export function DocumentParserSearchPage(): JSX.Element {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (): Promise<void> => {
    const term = q.trim();
    if (!term) {
      setHits(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetchJson<{ results: SearchHit[] }>(`${API}/search?q=${encodeURIComponent(term)}`);
      setHits(r.results);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'search failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-8">
      <header className="mb-6">
        <h1 className="text-lg font-semibold">Search</h1>
        <p className="text-sm text-ink-500">Full-text search across every parsed page. "sod" matches "sodding".</p>
      </header>

      <form
        className="mb-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. curb and gutter"
          className="flex-1 rounded border border-ink-200 bg-transparent px-3 py-2 text-sm dark:border-ink-700"
        />
        <button type="submit" disabled={busy} className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          {busy ? 'Searching…' : 'Search'}
        </button>
      </form>

      {error && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-900/30 dark:text-red-200">{error}</div>
      )}

      {hits === null ? null : hits.length === 0 ? (
        <div className="card p-8 text-center text-sm text-ink-500">No matches.</div>
      ) : (
        <div className="space-y-2">
          {hits.map((h) => (
            <article key={`${h.documentId}:${h.page}`} className="card p-4">
              <div className="mb-1 flex items-baseline gap-2 text-sm">
                <span className="font-medium">{h.title ?? h.suggestedTitle ?? h.originalFilename}</span>
                <span className="text-xs text-ink-500">page {h.page}</span>
              </div>
              <div className="text-sm text-ink-700 dark:text-ink-300">
                <Snippet text={h.snippet} />
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export const uiPages: ModuleUiPage[] = [
  { path: '', navLabel: 'Document Parser', Component: DocumentParserHomePage },
  { path: 'search', navLabel: 'Search', Component: DocumentParserSearchPage },
];

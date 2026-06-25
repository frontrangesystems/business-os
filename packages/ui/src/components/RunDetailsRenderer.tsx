import { useState } from 'react';

/**
 * Renders an agent run's `details` blob in a human-readable layout.
 *
 * Strategy: walk the top-level keys. For each value:
 *  - Array of objects with consistent keys → table (columns from union of keys)
 *  - Plain object → key/value block
 *  - Primitive → inline key/value row
 *
 * The raw JSON is always one click away via a "View raw" disclosure at the
 * bottom. Operators who know what they want can still grep the JSON.
 *
 * This is intentionally a one-day improvement on the previous `<pre>{JSON}</pre>`
 * dump. A more correct path would be an `outputSchema` declared by the agent
 * manifest and rendered by the framework, but that's a manifest change. For
 * now, sniffing the shape covers the common cases (digests, classifications,
 * cleanup batches).
 */
export function RunDetailsRenderer({ details }: { details: unknown }): JSX.Element {
  const [showRaw, setShowRaw] = useState(false);

  if (details === null || details === undefined) {
    return (
      <div className="py-10 text-center text-sm text-ink-500 dark:text-ink-400">
        No details emitted.
      </div>
    );
  }

  if (typeof details !== 'object') {
    return <PrimitiveValue value={details} />;
  }

  if (Array.isArray(details)) {
    return (
      <>
        <ArrayRenderer value={details} />
        <RawToggle details={details} showRaw={showRaw} setShowRaw={setShowRaw} />
      </>
    );
  }

  const entries = Object.entries(details as Record<string, unknown>);

  return (
    <>
      <div className="space-y-6">
        {entries.map(([key, value]) => (
          <DetailsSection key={key} label={key} value={value} />
        ))}
      </div>
      <RawToggle details={details} showRaw={showRaw} setShowRaw={setShowRaw} />
    </>
  );
}

function DetailsSection({ label, value }: { label: string; value: unknown }): JSX.Element {
  if (Array.isArray(value)) {
    return (
      <section>
        <SectionHeading>{humanLabel(label)}</SectionHeading>
        <ArrayRenderer value={value} />
      </section>
    );
  }
  if (value !== null && typeof value === 'object') {
    return (
      <section>
        <SectionHeading>{humanLabel(label)}</SectionHeading>
        <ObjectKeyValues value={value as Record<string, unknown>} />
      </section>
    );
  }
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-ink-500 dark:text-ink-400">{humanLabel(label)}</span>
      <PrimitiveValue value={value} />
    </div>
  );
}

function ArrayRenderer({ value }: { value: unknown[] }): JSX.Element {
  if (value.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-ink-200 px-3 py-6 text-center text-xs text-ink-500 dark:border-ink-700 dark:text-ink-400">
        Empty list.
      </div>
    );
  }
  const allObjects = value.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v));
  if (!allObjects) {
    return (
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {value.map((v, i) => (
          <li key={i}>
            <PrimitiveValue value={v} />
          </li>
        ))}
      </ul>
    );
  }
  const rows = value as Array<Record<string, unknown>>;
  // Column order = union of all keys, preserving first-seen order, but with
  // opaque id-shaped columns pushed to the end so the meaningful fields
  // (subject, from, score, reason, …) lead. On a narrow screen the first
  // columns are what's visible without scrolling, so this matters.
  const allCols: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) {
    seen.add(k);
    allCols.push(k);
  }
  const isIdCol = (c: string): boolean => /^(id|.*Id|.*_id|uuid|guid)$/i.test(c);
  const cols = [...allCols.filter((c) => !isIdCol(c)), ...allCols.filter(isIdCol)];
  return (
    <>
      {/* Desktop / wide: scannable table. */}
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full text-sm">
          <thead className="text-[11px] uppercase tracking-wider text-ink-500 dark:text-ink-400">
            <tr>
              {cols.map((c) => (
                <th key={c} className="px-3 py-2 text-left font-medium">
                  {humanLabel(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
            {rows.map((row, i) => (
              <tr key={i} className="align-top">
                {cols.map((c) => (
                  <td key={c} className="px-3 py-2">
                    <CellValue value={row[c]} columnKey={c} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Mobile: one card per row — fields stack and wrap, no horizontal scroll. */}
      <div className="space-y-3 sm:hidden">
        {rows.map((row, i) => (
          <div
            key={i}
            className="rounded-md border border-ink-100 p-3 dark:border-ink-800"
          >
            <dl className="grid grid-cols-[minmax(72px,auto)_1fr] gap-x-3 gap-y-1">
              {cols.map((c) => (
                <div key={c} className="contents text-sm">
                  <dt className="text-[11px] uppercase tracking-wide text-ink-500 dark:text-ink-400">
                    {humanLabel(c)}
                  </dt>
                  <dd className="min-w-0 break-words">
                    <CellValue value={row[c]} columnKey={c} />
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </>
  );
}

function ObjectKeyValues({ value }: { value: Record<string, unknown> }): JSX.Element {
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return (
      <div className="text-xs text-ink-500 dark:text-ink-400">Empty.</div>
    );
  }
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-[minmax(120px,200px)_1fr]">
      {entries.map(([k, v]) => (
        <div key={k} className="contents text-sm">
          <dt className="text-ink-500 dark:text-ink-400">{humanLabel(k)}</dt>
          <dd>
            <CellValue value={v} columnKey={k} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function CellValue({ value, columnKey }: { value: unknown; columnKey: string }): JSX.Element {
  if (value === null || value === undefined) {
    return <span className="text-ink-400 dark:text-ink-500">—</span>;
  }
  if (typeof value === 'string') {
    // Truncate long strings (e.g. snippets). Always-visible expand on hover via title.
    const trimmed = value.replace(/\s+/g, ' ').trim();
    if (trimmed.length > 200) {
      return (
        <span title={trimmed} className="block max-w-prose text-xs text-ink-700 dark:text-ink-300">
          {trimmed.slice(0, 200)}…
        </span>
      );
    }
    // ISO date strings → localized.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) {
      const d = new Date(trimmed);
      if (!Number.isNaN(d.valueOf())) {
        return <span className="font-mono text-xs">{d.toLocaleString()}</span>;
      }
    }
    // ID-shaped column → mono.
    if (/^(id|.*Id|.*_id)$/.test(columnKey)) {
      return <span className="font-mono text-xs">{trimmed}</span>;
    }
    return <span className="text-sm">{trimmed}</span>;
  }
  if (typeof value === 'number') {
    // Score-ish columns rendered with 2 decimals.
    if (/score|confidence|threshold|ratio/i.test(columnKey) && Number.isFinite(value)) {
      return <span className="font-mono text-xs">{value.toFixed(2)}</span>;
    }
    return <span className="font-mono text-xs">{value}</span>;
  }
  if (typeof value === 'boolean') {
    return <span className="font-mono text-xs">{value ? 'true' : 'false'}</span>;
  }
  // Nested object/array — show compact JSON inline.
  return (
    <code className="block whitespace-pre-wrap break-all font-mono text-[11px] text-ink-700 dark:text-ink-300">
      {JSON.stringify(value)}
    </code>
  );
}

function PrimitiveValue({ value }: { value: unknown }): JSX.Element {
  return <CellValue value={value} columnKey="" />;
}

function SectionHeading({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500 dark:text-ink-400">
      {children}
    </h3>
  );
}

function RawToggle({
  details,
  showRaw,
  setShowRaw,
}: {
  details: unknown;
  showRaw: boolean;
  setShowRaw: (v: boolean) => void;
}): JSX.Element {
  return (
    <div className="mt-6 border-t border-ink-100 pt-4 dark:border-ink-800">
      <button
        className="text-xs font-medium text-accent transition-colors hover:text-accent-hover hover:underline"
        onClick={() => setShowRaw(!showRaw)}
      >
        {showRaw ? 'Hide raw JSON' : 'View raw JSON'}
      </button>
      {showRaw && (
        <pre className="mt-3 max-h-96 overflow-auto rounded-md bg-ink-50 p-3 font-mono text-xs leading-relaxed text-ink-800 dark:bg-ink-950 dark:text-ink-200">
          {JSON.stringify(details, null, 2)}
        </pre>
      )}
    </div>
  );
}

function humanLabel(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

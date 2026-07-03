import { z } from 'zod';
import {
  defineConnector,
  type ConnectorContext,
  type EmailInboxCapability,
  type InboxLabel,
  type InboxMessage,
  type InboxMessageSummary,
  type ListMessagesOpts,
  type ListMessagesResult,
  type SearchOpts,
} from '@frontrangesystems/business-os-connector-sdk';
import { ComposioSubstrate, ComposioSubstrateError } from '@frontrangesystems/business-os-connector-composio';

/**
 * Gmail provider for the `email-inbox` capability, backed by Composio.
 *
 * Credentials shape (set by the framework when the operator connects an
 * account through the Settings UI):
 *   kind: 'api-key'
 *   key:  <COMPOSIO_API_KEY>            // platform-level, from env
 *   extra.userId: <composio entity id>  // per-account, identifies which
 *                                        // connected Gmail account to act on
 *
 * The OAuth dance happens outside this connector. This connector only
 * consumes the already-connected userId.
 */

const settingsSchema = z.object({
  /** Free-form label for logs / audit metadata. */
  label: z.string().default('gmail-inbox-composio'),
  /** Default page size when caller omits one. */
  defaultPageSize: z.number().int().min(1).max(200).default(50),
});

type Settings = z.infer<typeof settingsSchema>;

const TOOLKIT = 'gmail';
// Composio's GMAIL_FETCH_EMAILS returns full message bodies in the response
// payload, so requesting ~100+ messages can trip Composio's upstream
// Upstream_PayloadTooLarge (413). 50 is the empirically-safe ceiling; agents
// paginate when they need more.
const MAX_PAGE_SIZE = 50;
const SNIPPET_LEN = 200;

function getUserId(ctx: ConnectorContext<Settings>): string {
  if (ctx.credentials.kind !== 'api-key') {
    throw new Error(
      `connector-email-inbox-gmail-composio requires api-key credentials, got "${ctx.credentials.kind}"`,
    );
  }
  const userId = ctx.credentials.extra?.userId;
  if (!userId) {
    throw new Error(
      'connector-email-inbox-gmail-composio requires credentials.extra.userId (the Composio entity)',
    );
  }
  return userId;
}

function makeSubstrate(ctx: ConnectorContext<Settings>): ComposioSubstrate {
  if (ctx.credentials.kind !== 'api-key') {
    throw new Error('expected api-key credentials');
  }
  return new ComposioSubstrate({ apiKey: ctx.credentials.key });
}

// -----------------------------------------------------------------------------
// Gmail response shapes — Composio surfaces the raw Gmail API payload nested
// under data.*; we extract just the fields we need.
// -----------------------------------------------------------------------------

interface GmailMessage {
  /** Composio's Gmail tools return the message id under `messageId`, NOT `id`. */
  messageId?: string;
  threadId?: string;
  subject?: string;
  sender?: string;
  to?: string;
  cc?: string;
  snippet?: string;
  preview?: { body?: string };
  messageText?: string;
  messageTimestamp?: string;
  labelIds?: string[];
  /** Composio-provided deep link to the message in Gmail web UI. */
  display_url?: string;
  payload?: {
    headers?: Array<{ name?: string; value?: string }>;
    body?: { data?: string };
    parts?: Array<{ mimeType?: string; body?: { data?: string } }>;
  };
}

interface GmailFetchResult {
  messages?: GmailMessage[];
  nextPageToken?: string;
}

interface GmailLabel {
  id?: string;
  name?: string;
  type?: string; // 'system' | 'user'
}

interface GmailListLabelsResult {
  labels?: GmailLabel[];
}

function header(msg: GmailMessage, name: string): string | undefined {
  const h = msg.payload?.headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value;
}

function decodeB64Url(s: string): string {
  try {
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function bodyText(msg: GmailMessage): string {
  if (msg.messageText) return msg.messageText;
  const direct = msg.payload?.body?.data;
  if (direct) return decodeB64Url(direct);
  const textPart = msg.payload?.parts?.find((p) => p.mimeType === 'text/plain');
  if (textPart?.body?.data) return decodeB64Url(textPart.body.data);
  return '';
}

function bodyHtml(msg: GmailMessage): string | undefined {
  const part = msg.payload?.parts?.find((p) => p.mimeType === 'text/html');
  if (part?.body?.data) return decodeB64Url(part.body.data);
  return undefined;
}

function splitAddrs(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function toSummary(msg: GmailMessage): InboxMessageSummary {
  const from = msg.sender ?? header(msg, 'From') ?? '';
  const subject = msg.subject ?? header(msg, 'Subject') ?? '';
  const dateHeader = header(msg, 'Date');
  const ts = msg.messageTimestamp ?? dateHeader;
  const labels = msg.labelIds ?? [];
  const snippetSource = msg.snippet ?? bodyText(msg).slice(0, SNIPPET_LEN);
  return {
    id: msg.messageId ?? '',
    threadId: msg.threadId ?? msg.messageId ?? '',
    from,
    to: splitAddrs(msg.to ?? header(msg, 'To')),
    cc: msg.cc !== undefined || header(msg, 'Cc') !== undefined
      ? splitAddrs(msg.cc ?? header(msg, 'Cc'))
      : undefined,
    subject,
    snippet: snippetSource,
    receivedAt: ts ? new Date(ts) : new Date(),
    unread: labels.includes('UNREAD'),
    labels,
  };
}

function toFull(msg: GmailMessage): InboxMessage {
  const summary = toSummary(msg);
  const headersMap: Record<string, string> = {};
  for (const h of msg.payload?.headers ?? []) {
    if (h.name && h.value) headersMap[h.name] = h.value;
  }
  return {
    ...summary,
    text: bodyText(msg),
    html: bodyHtml(msg),
    headers: Object.keys(headersMap).length > 0 ? headersMap : undefined,
  };
}

function gmailDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}`;
}

function buildQuery(opts: ListMessagesOpts): string {
  const parts: string[] = [];
  if (opts.unreadOnly) parts.push('is:unread');
  if (opts.since) parts.push(`after:${gmailDate(opts.since)}`);
  if (opts.until) parts.push(`before:${gmailDate(opts.until)}`);
  if (opts.labelId) parts.push(`label:${opts.labelId}`);
  return parts.join(' ');
}

function clampPageSize(requested: number | undefined, fallback: number): number {
  const n = requested ?? fallback;
  return Math.min(Math.max(n, 1), MAX_PAGE_SIZE);
}

// -----------------------------------------------------------------------------
// Capability impl
// -----------------------------------------------------------------------------

function makeInbox(ctx: ConnectorContext<Settings>): EmailInboxCapability {
  const userId = getUserId(ctx);
  const substrate = makeSubstrate(ctx);
  const defaultSize = ctx.settings.defaultPageSize;

  async function fetchEmails(
    query: string,
    pageSize: number,
    cursor?: string,
  ): Promise<ListMessagesResult> {
    const args: Record<string, unknown> = { max_results: pageSize };
    if (query) args.query = query;
    if (cursor) args.page_token = cursor;

    const out = await substrate.executeTool<GmailFetchResult>({
      toolSlug: 'GMAIL_FETCH_EMAILS',
      userId,
      arguments: args,
    });
    if (!out.successful) {
      throw new Error(`gmail list failed: ${out.error ?? 'unknown error'}`);
    }
    return {
      messages: (out.data.messages ?? []).map(toSummary),
      nextCursor: out.data.nextPageToken ?? null,
    };
  }

  async function modifyLabels(ids: string[], add: string[], remove: string[]): Promise<void> {
    if (ids.length === 0) return;
    for (const id of ids) {
      // TODO: verify slug against Composio toolkit docs — may also be exposed
      // as GMAIL_MODIFY_THREAD_LABELS or GMAIL_ADD_LABEL_TO_EMAIL depending on
      // toolkit version.
      const out = await substrate.executeTool({
        toolSlug: 'GMAIL_MODIFY_LABELS',
        userId,
        arguments: {
          message_id: id,
          add_label_ids: add,
          remove_label_ids: remove,
        },
      });
      if (!out.successful) {
        throw new Error(`gmail modify labels failed: ${out.error ?? 'unknown error'}`);
      }
    }
  }

  return {
    async listMessages(opts: ListMessagesOpts): Promise<ListMessagesResult> {
      const pageSize = clampPageSize(opts.pageSize, defaultSize);
      const query = buildQuery(opts);
      ctx.logger.info(
        { label: ctx.settings.label, query, pageSize },
        'gmail-inbox-composio.listMessages',
      );
      return fetchEmails(query, pageSize, opts.cursor);
    },

    async getMessage(id: string): Promise<InboxMessage> {
      const out = await substrate.executeTool<GmailMessage>({
        toolSlug: 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
        userId,
        arguments: { message_id: id, format: 'full' },
      });
      if (!out.successful) {
        throw new Error(`gmail get failed: ${out.error ?? 'unknown error'}`);
      }
      return toFull(out.data);
    },

    async markRead(ids: string[]): Promise<void> {
      await modifyLabels(ids, [], ['UNREAD']);
    },

    async markUnread(ids: string[]): Promise<void> {
      await modifyLabels(ids, ['UNREAD'], []);
    },

    async archive(ids: string[]): Promise<void> {
      await modifyLabels(ids, [], ['INBOX']);
    },

    async trash(ids: string[]): Promise<void> {
      await modifyLabels(ids, ['TRASH'], ['INBOX']);
    },

    async deletePermanently(ids: string[]): Promise<void> {
      for (const id of ids) {
        const out = await substrate.executeTool({
          toolSlug: 'GMAIL_DELETE_MESSAGE',
          userId,
          arguments: { message_id: id },
        });
        if (!out.successful) {
          throw new Error(`gmail delete failed: ${out.error ?? 'unknown error'}`);
        }
      }
    },

    async addLabels(ids: string[], labels: string[]): Promise<void> {
      await modifyLabels(ids, labels, []);
    },

    async removeLabels(ids: string[], labels: string[]): Promise<void> {
      await modifyLabels(ids, [], labels);
    },

    async listLabels(): Promise<InboxLabel[]> {
      const out = await substrate.executeTool<GmailListLabelsResult>({
        toolSlug: 'GMAIL_LIST_LABELS',
        userId,
        arguments: {},
      });
      if (!out.successful) {
        throw new Error(`gmail list labels failed: ${out.error ?? 'unknown error'}`);
      }
      return (out.data.labels ?? []).map((l) => ({
        id: l.id ?? '',
        name: l.name ?? '',
        isUserDefined: l.type === 'user',
      }));
    },

    async search(query: string, opts?: SearchOpts): Promise<ListMessagesResult> {
      const pageSize = clampPageSize(opts?.pageSize, defaultSize);
      return fetchEmails(query, pageSize, opts?.cursor);
    },
  };
}

/**
 * Maps framework-level event topics to the Composio trigger slugs that fire
 * them. The framework speaks `'email-inbox.message.received'`; Composio
 * speaks `'GMAIL_NEW_GMAIL_MESSAGE'`. The connector translates.
 */
const EVENT_TOPICS = {
  'email-inbox.message.received': {
    composioSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
    displayName: 'New Gmail message',
  },
} as const;

export const manifest = {
  slug: 'email-inbox-gmail-composio',
  capability: 'email-inbox' as const,
  version: '0.0.1',
  displayName: 'Gmail Inbox',
  authKind: 'api-key' as const,
  externalOAuth: {
    provider: 'composio' as const,
    toolkit: TOOLKIT,
  },
  settingsSchema,
  events: Object.fromEntries(
    Object.entries(EVENT_TOPICS).map(([topic, def]) => [topic, { displayName: def.displayName }]),
  ),
};

export default defineConnector({
  manifest,
  factory: (ctx) => makeInbox(ctx as ConnectorContext<Settings>),
  /**
   * Register Composio trigger subscriptions for each requested topic.
   * Returns a single subscription handle that bundles every Composio trigger
   * id created in this call — the framework hands it back to
   * `unsubscribeFromEvents` later to tear them all down at once.
   */
  async subscribeToEvents(ctx, topics) {
    const userId = getUserId(ctx as ConnectorContext<Settings>);
    const substrate = makeSubstrate(ctx as ConnectorContext<Settings>);
    const triggerIds: string[] = [];
    for (const topic of topics) {
      const def = EVENT_TOPICS[topic as keyof typeof EVENT_TOPICS];
      if (!def) {
        throw new Error(`gmail-composio: unknown event topic "${topic}"`);
      }
      const out = await substrate.createTrigger({ userId, slug: def.composioSlug });
      triggerIds.push(out.id);
    }
    return { subscriptionId: triggerIds.join(',') };
  },
  async unsubscribeFromEvents(ctx, subscriptionId) {
    const substrate = makeSubstrate(ctx as ConnectorContext<Settings>);
    const ids = subscriptionId.split(',').filter(Boolean);
    for (const id of ids) {
      // Best-effort: if Composio's already cleaned this up (e.g. user
      // disconnected the account), keep going instead of half-tearing-down.
      try {
        await substrate.deleteTrigger(id);
      } catch {
        // swallow — the framework re-attempts on rebind
      }
    }
  },
});

export { ComposioSubstrate, ComposioSubstrateError };
export { EVENT_TOPICS };

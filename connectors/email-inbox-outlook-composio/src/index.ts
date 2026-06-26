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
 * Outlook provider for the `email-inbox` capability, backed by Composio.
 *
 * Outlook is exposed via Microsoft Graph; Composio wraps the verbs we need.
 * Outlook uses *categories* in place of Gmail's labels, and uses *folders*
 * (Archive, DeletedItems) where Gmail uses label-add/remove for INBOX/TRASH.
 *
 * Credentials shape: same as the Gmail-via-Composio connector —
 *   kind: 'api-key'
 *   key:  <COMPOSIO_API_KEY>
 *   extra.userId: <composio entity id>
 */

const settingsSchema = z.object({
  label: z.string().default('outlook-inbox-composio'),
  defaultPageSize: z.number().int().min(1).max(200).default(50),
  /** Folder names — operator can override if the mailbox uses non-default names. */
  archiveFolder: z.string().default('Archive'),
  trashFolder: z.string().default('DeletedItems'),
});

type Settings = z.infer<typeof settingsSchema>;

const TOOLKIT = 'outlook';
const MAX_PAGE_SIZE = 200;
const SNIPPET_LEN = 200;

function getUserId(ctx: ConnectorContext<Settings>): string {
  if (ctx.credentials.kind !== 'api-key') {
    throw new Error(
      `connector-email-inbox-outlook-composio requires api-key credentials, got "${ctx.credentials.kind}"`,
    );
  }
  const userId = ctx.credentials.extra?.userId;
  if (!userId) {
    throw new Error(
      'connector-email-inbox-outlook-composio requires credentials.extra.userId (the Composio entity)',
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
// Outlook (Microsoft Graph) response shapes
// -----------------------------------------------------------------------------

interface OutlookEmailAddress {
  emailAddress?: { address?: string; name?: string };
}

interface OutlookMessage {
  id?: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  from?: OutlookEmailAddress;
  toRecipients?: OutlookEmailAddress[];
  ccRecipients?: OutlookEmailAddress[];
  receivedDateTime?: string;
  isRead?: boolean;
  categories?: string[];
  body?: { contentType?: string; content?: string };
  internetMessageHeaders?: Array<{ name?: string; value?: string }>;
}

interface OutlookListResult {
  value?: OutlookMessage[];
  '@odata.nextLink'?: string;
}

interface OutlookCategory {
  id?: string;
  displayName?: string;
}

interface OutlookListCategoriesResult {
  value?: OutlookCategory[];
}

interface OutlookMailFolder {
  id?: string;
  displayName?: string;
  totalItemCount?: number;
  unreadItemCount?: number;
}

interface OutlookListFoldersResult {
  value?: OutlookMailFolder[];
}

function addr(a: OutlookEmailAddress | undefined): string {
  return a?.emailAddress?.address ?? '';
}

function addrs(list: OutlookEmailAddress[] | undefined): string[] {
  return (list ?? []).map(addr).filter(Boolean);
}

function toSummary(msg: OutlookMessage): InboxMessageSummary {
  return {
    id: msg.id ?? '',
    threadId: msg.conversationId ?? msg.id ?? '',
    from: addr(msg.from),
    to: addrs(msg.toRecipients),
    cc: msg.ccRecipients ? addrs(msg.ccRecipients) : undefined,
    subject: msg.subject ?? '',
    snippet: msg.bodyPreview ?? (msg.body?.content ?? '').slice(0, SNIPPET_LEN),
    receivedAt: msg.receivedDateTime ? new Date(msg.receivedDateTime) : new Date(),
    unread: msg.isRead === false,
    labels: msg.categories ?? [],
  };
}

function toFull(msg: OutlookMessage): InboxMessage {
  const summary = toSummary(msg);
  const isHtml = msg.body?.contentType === 'html';
  const content = msg.body?.content ?? '';
  const headers: Record<string, string> = {};
  for (const h of msg.internetMessageHeaders ?? []) {
    if (h.name && h.value) headers[h.name] = h.value;
  }
  return {
    ...summary,
    text: isHtml ? '' : content,
    html: isHtml ? content : undefined,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  };
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
  const { archiveFolder, trashFolder } = ctx.settings;

  async function listMessagesRaw(
    args: Record<string, unknown>,
  ): Promise<{ raw: OutlookListResult }> {
    // GET_MAIL_DELTA is the verified Composio slug for listing/paging inbox messages.
    // It does not support OData $filter — callers must post-filter the returned page.
    // Pagination: pass the full @odata.nextLink URL as skip_token.
    const { next_link, filter: _filter, ...rest } = args;
    const toolArgs: Record<string, unknown> = { ...rest };
    if (next_link) toolArgs.skip_token = next_link;
    const out = await substrate.executeTool<OutlookListResult>({
      toolSlug: 'OUTLOOK_GET_MAIL_DELTA',
      userId,
      arguments: toolArgs,
    });
    if (!out.successful) {
      throw new Error(`outlook list failed: ${out.error ?? 'unknown error'}`);
    }
    return { raw: out.data };
  }

  async function updateMessage(id: string, patch: Record<string, unknown>): Promise<void> {
    // OUTLOOK_BATCH_UPDATE_MESSAGES is the verified slug. It wraps a single-message
    // update in the batch envelope. Patch keys use Graph camelCase (isRead, categories).
    const out = await substrate.executeTool({
      toolSlug: 'OUTLOOK_BATCH_UPDATE_MESSAGES',
      userId,
      arguments: { updates: [{ message_id: id, patch }] },
    });
    if (!out.successful) {
      throw new Error(`outlook update failed: ${out.error ?? 'unknown error'}`);
    }
  }

  async function moveMessage(id: string, destinationId: string): Promise<void> {
    // OUTLOOK_BATCH_MOVE_MESSAGES is the verified slug.
    const out = await substrate.executeTool({
      toolSlug: 'OUTLOOK_BATCH_MOVE_MESSAGES',
      userId,
      arguments: { message_ids: [id], destination_id: destinationId },
    });
    if (!out.successful) {
      throw new Error(`outlook move failed: ${out.error ?? 'unknown error'}`);
    }
  }

  return {
    async listMessages(opts: ListMessagesOpts): Promise<ListMessagesResult> {
      const pageSize = clampPageSize(opts.pageSize, defaultSize);
      const args: Record<string, unknown> = { top: pageSize };
      if (opts.labelId) args.folder_id = opts.labelId;
      if (opts.cursor) args.next_link = opts.cursor;
      ctx.logger.info(
        { label: ctx.settings.label, pageSize },
        'outlook-inbox-composio.listMessages',
      );
      const { raw } = await listMessagesRaw(args);
      let messages = (raw.value ?? []).map(toSummary);
      // GET_MAIL_DELTA has no server-side $filter; apply requested filters on the page.
      if (opts.unreadOnly) messages = messages.filter((m) => m.unread);
      if (opts.since) { const since = opts.since; messages = messages.filter((m) => m.receivedAt >= since); }
      if (opts.until) { const until = opts.until; messages = messages.filter((m) => m.receivedAt <= until); }
      return { messages, nextCursor: raw['@odata.nextLink'] ?? null };
    },

    async getMessage(id: string): Promise<InboxMessage> {
      const out = await substrate.executeTool<OutlookMessage>({
        toolSlug: 'OUTLOOK_GET_MESSAGE',
        userId,
        arguments: { message_id: id },
      });
      if (!out.successful) {
        throw new Error(`outlook get failed: ${out.error ?? 'unknown error'}`);
      }
      return toFull(out.data);
    },

    async markRead(ids: string[]): Promise<void> {
      for (const id of ids) await updateMessage(id, { isRead: true });
    },

    async markUnread(ids: string[]): Promise<void> {
      for (const id of ids) await updateMessage(id, { isRead: false });
    },

    async archive(ids: string[]): Promise<void> {
      for (const id of ids) await moveMessage(id, archiveFolder);
    },

    async trash(ids: string[]): Promise<void> {
      for (const id of ids) await moveMessage(id, trashFolder);
    },

    async deletePermanently(ids: string[]): Promise<void> {
      for (const id of ids) {
        const out = await substrate.executeTool({
          toolSlug: 'OUTLOOK_DELETE_MESSAGE',
          userId,
          arguments: { message_id: id },
        });
        if (!out.successful) {
          throw new Error(`outlook delete failed: ${out.error ?? 'unknown error'}`);
        }
      }
    },

    async addLabels(ids: string[], labels: string[]): Promise<void> {
      for (const id of ids) {
        await updateMessage(id, { categories: labels });
      }
    },

    async removeLabels(ids: string[], labels: string[]): Promise<void> {
      // Read-modify-write: fetch existing categories, drop the requested ones.
      for (const id of ids) {
        const out = await substrate.executeTool<OutlookMessage>({
          toolSlug: 'OUTLOOK_GET_MESSAGE',
          userId,
          arguments: { message_id: id },
        });
        if (!out.successful) {
          throw new Error(`outlook get (for removeLabels) failed: ${out.error ?? 'unknown'}`);
        }
        const existing = out.data.categories ?? [];
        const next = existing.filter((c) => !labels.includes(c));
        await updateMessage(id, { categories: next });
      }
    },

    async listLabels(): Promise<InboxLabel[]> {
      // OUTLOOK_LIST_MAIL_FOLDERS — best-guess Composio slug for GET /me/mailFolders.
      // Verify against Composio Outlook tool list if this fails at runtime.
      const out = await substrate.executeTool<OutlookListFoldersResult>({
        toolSlug: 'OUTLOOK_LIST_MAIL_FOLDERS',
        userId,
        arguments: {},
      });
      if (!out.successful) {
        throw new Error(`outlook list folders failed: ${out.error ?? 'unknown error'}`);
      }
      return (out.data.value ?? []).map((f) => ({
        id: f.id ?? '',
        name: f.displayName ?? '',
        isUserDefined: true,
      }));
    },

    async search(_query: string, _opts?: SearchOpts): Promise<ListMessagesResult> {
      // Composio's OUTLOOK_GET_MAIL_DELTA does not expose Graph $search.
      // Full-text search is not supported by this connector provider.
      throw new Error('outlook-inbox-composio: full-text search is not supported via this provider');
    },
  };
}

export const manifest = {
  slug: 'email-inbox-outlook-composio',
  capability: 'email-inbox' as const,
  version: '0.0.3',
  displayName: 'Outlook Inbox (via Composio)',
  authKind: 'api-key' as const,
  externalOAuth: {
    provider: 'composio' as const,
    toolkit: TOOLKIT,
  },
  settingsSchema,
};

export default defineConnector({
  manifest,
  factory: (ctx) => makeInbox(ctx as ConnectorContext<Settings>),
});

export { ComposioSubstrate, ComposioSubstrateError };

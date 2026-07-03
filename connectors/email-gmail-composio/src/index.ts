import { z } from 'zod';
import {
  defineConnector,
  type ConnectorContext,
  type EmailCapability,
  type InboundEmail,
  type OutboundEmail,
} from '@frontrangesystems/business-os-connector-sdk';
import { ComposioSubstrate, ComposioSubstrateError } from '@frontrangesystems/business-os-connector-composio';

/**
 * Gmail provider for the `email` capability, backed by Composio.
 *
 * Credentials shape (set by the framework when the operator connects an
 * account through the Settings UI):
 *   kind: 'api-key'
 *   key:  <COMPOSIO_API_KEY>            // platform-level, from env
 *   extra.userId: <composio entity id>  // per-account, identifies which
 *                                        // connected Gmail account to act on
 *
 * The OAuth dance happens outside this connector: the framework calls
 * substrate.createConnectionLink() and substrate.getActiveConnection() during
 * the "Connect Gmail" → callback flow. This connector only consumes the
 * already-connected userId.
 */

const settingsSchema = z.object({
  /** Free-form label for logs / audit metadata. */
  label: z.string().default('gmail-composio'),
});

type Settings = z.infer<typeof settingsSchema>;

const TOOLKIT = 'gmail';

function getUserId(ctx: ConnectorContext<Settings>): string {
  if (ctx.credentials.kind !== 'api-key') {
    throw new Error(
      `connector-email-gmail-composio requires api-key credentials, got "${ctx.credentials.kind}"`,
    );
  }
  const userId = ctx.credentials.extra?.userId;
  if (!userId) {
    throw new Error(
      'connector-email-gmail-composio requires credentials.extra.userId (the Composio entity)',
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
// Gmail response shapes (subset we care about — Composio returns the raw
// Gmail API payload nested under data.*; we extract just what InboundEmail
// needs).
// -----------------------------------------------------------------------------

interface GmailMessage {
  id?: string;
  threadId?: string;
  subject?: string;
  sender?: string;
  to?: string;
  messageText?: string;
  messageTimestamp?: string;
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

function header(msg: GmailMessage, name: string): string | undefined {
  const h = msg.payload?.headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value;
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

function decodeB64Url(s: string): string {
  // Gmail uses URL-safe base64
  try {
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function toInbound(msg: GmailMessage): InboundEmail {
  const from = msg.sender ?? header(msg, 'From') ?? '';
  const toRaw = msg.to ?? header(msg, 'To') ?? '';
  const subject = msg.subject ?? header(msg, 'Subject') ?? '';
  const dateHeader = header(msg, 'Date');
  const ts = msg.messageTimestamp ?? dateHeader;
  return {
    id: msg.id ?? '',
    threadId: msg.threadId ?? msg.id ?? '',
    from,
    to: toRaw ? toRaw.split(',').map((s) => s.trim()).filter(Boolean) : [],
    subject,
    text: bodyText(msg),
    html: bodyHtml(msg),
    receivedAt: ts ? new Date(ts) : new Date(),
  };
}

// -----------------------------------------------------------------------------
// Capability impl
// -----------------------------------------------------------------------------

function makeEmail(ctx: ConnectorContext<Settings>): EmailCapability {
  const userId = getUserId(ctx);
  const substrate = makeSubstrate(ctx);

  return {
    async send(msg: OutboundEmail): Promise<{ messageId: string }> {
      const to = Array.isArray(msg.to) ? msg.to.join(', ') : msg.to;
      const body = msg.html ?? msg.text ?? '';
      const isHtml = Boolean(msg.html);
      const args: Record<string, unknown> = {
        recipient_email: to,
        subject: msg.subject,
        body,
        is_html: isHtml,
      };
      if (msg.threadId) args.thread_id = msg.threadId;

      const out = await substrate.executeTool<{ id?: string; threadId?: string }>({
        toolSlug: 'GMAIL_SEND_EMAIL',
        userId,
        arguments: args,
      });
      if (!out.successful) {
        throw new Error(`gmail send failed: ${out.error ?? 'unknown error'}`);
      }
      const messageId = out.data.id ?? '';
      ctx.logger.info(
        { label: ctx.settings.label, to, subject: msg.subject, messageId },
        'gmail-composio.send',
      );
      return { messageId };
    },

    async listInbox(opts): Promise<InboundEmail[]> {
      const queryParts: string[] = [];
      if (opts.unreadOnly) queryParts.push('is:unread');
      if (opts.since) {
        // Gmail expects YYYY/MM/DD for `after:`
        const d = opts.since;
        const yyyy = d.getUTCFullYear();
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        queryParts.push(`after:${yyyy}/${mm}/${dd}`);
      }
      const args: Record<string, unknown> = {
        max_results: opts.limit ?? 25,
      };
      if (queryParts.length > 0) args.query = queryParts.join(' ');

      const out = await substrate.executeTool<GmailFetchResult>({
        toolSlug: 'GMAIL_FETCH_EMAILS',
        userId,
        arguments: args,
      });
      if (!out.successful) {
        throw new Error(`gmail list failed: ${out.error ?? 'unknown error'}`);
      }
      return (out.data.messages ?? []).map(toInbound);
    },

    async getMessage(id: string): Promise<InboundEmail> {
      const out = await substrate.executeTool<GmailMessage>({
        toolSlug: 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
        userId,
        arguments: { message_id: id, format: 'full' },
      });
      if (!out.successful) {
        throw new Error(`gmail get failed: ${out.error ?? 'unknown error'}`);
      }
      return toInbound(out.data);
    },
  };
}

export const manifest = {
  slug: 'email-gmail-composio',
  capability: 'email' as const,
  version: '0.0.1',
  displayName: 'Gmail',
  // `api-key` here = the Composio platform API key; per-account OAuth state
  // lives at Composio and is referenced by extra.userId. From the framework's
  // POV this looks like an api-key connector even though the underlying
  // provider auth is OAuth2 — the framework picks up on `externalOAuth`
  // below and drives the "Connect Gmail" flow accordingly instead of asking
  // the operator to paste an API key.
  authKind: 'api-key' as const,
  externalOAuth: {
    provider: 'composio' as const,
    toolkit: TOOLKIT,
  },
  settingsSchema,
};

export default defineConnector({
  manifest,
  factory: (ctx) => makeEmail(ctx as ConnectorContext<Settings>),
});

// Re-export for tests / framework wiring.
export { ComposioSubstrate, ComposioSubstrateError };

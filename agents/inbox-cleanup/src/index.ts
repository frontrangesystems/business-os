import { z } from 'zod';
import {
  defineAgent,
  LlmPickerSchema,
  resolveLlm,
  type AgentResult,
} from '@frontrangesystems/business-os-agent-sdk';
import type {
  EmailInboxCapability,
  InboxMessageSummary,
  ListMessagesResult,
} from '@frontrangesystems/business-os-connector-sdk';

/**
 * Inbox-cleanup agent.
 *
 * Solves the "4000 unread emails" problem. We page through the inbox,
 * cluster messages by sender, then ask the LLM to classify each sender as
 * archive / trash / keep. We honor an operator-maintained "never touch"
 * allow-list and respect a dry-run mode so the first run is safe.
 */

const InputSchema = z.object({}).optional();

const SettingsSchema = z.object({
  llm: LlmPickerSchema.default({}),
  maxMessages: z
    .number()
    .int()
    .min(1)
    .max(2000)
    .default(500)
    .describe('How many recent messages to scan in one run. Larger = more thorough, slower, more LLM tokens.'),
  cleanupAction: z
    .enum(['archive', 'trash', 'dry-run'])
    .default('dry-run')
    .describe(
      'Safety dial. dry-run = preview only, change nothing. archive = safer, anything the model recommends trashing is downgraded to archive. trash = honor the model, archive or trash as it sees fit.',
    ),
  neverTouchSenders: z
    .array(z.string())
    .default([])
    .describe('Senders to always leave alone, regardless of the model. One email address per line.'),
  unreadOnly: z
    .boolean()
    .default(true)
    .describe('Only consider unread messages. Turn off to sweep already-read backlog too.'),
  minGroupSize: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(3)
    .describe(
      'Minimum messages from a single sender before the model considers cleanup. Default 3 protects personal/work email. Set to 1 to process every sender in the batch.',
    ),
  folder: z
    .string()
    .optional()
    .describe(
      'Folder name to process (e.g. "notification", "marketing"). Leave empty to process the inbox. Case-insensitive — the agent resolves the name to an ID automatically.',
    ),
});

type Settings = z.infer<typeof SettingsSchema>;

/** Hard cap on per-page size per the connector contract. */
const PAGE_SIZE = 200;

const ClassificationSchema = z.object({
  decisions: z.array(
    z.object({
      sender: z.string(),
      action: z.enum(['archive', 'trash', 'keep']),
    }),
  ),
});
type Classification = z.infer<typeof ClassificationSchema>;

interface SenderGroup {
  sender: string;
  ids: string[];
  exampleSubjects: string[];
  totalCount: number;
}

/**
 * "Foo <foo@bar.com>" -> "foo@bar.com". Lowercased. If we can't pull an
 * address out we fall back to lowercasing whatever we were given so the
 * grouping still clusters consistently.
 */
export function canonicalizeSender(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  const addr = (match?.[1] ?? raw).trim().toLowerCase();
  return addr;
}

/** Domain of an address ("foo@bar.com" -> "bar.com"), or null. */
function domainOf(addr: string): string | null {
  const idx = addr.indexOf('@');
  return idx >= 0 ? addr.slice(idx + 1) : null;
}

/**
 * True when `sender` matches one of the operator's never-touch entries.
 * An entry is treated as an exact address match OR as a domain match
 * (entries without an `@` are interpreted as domain rules).
 */
export function senderIsProtected(
  sender: string,
  neverTouch: ReadonlyArray<string>,
): boolean {
  if (neverTouch.length === 0) return false;
  const canon = canonicalizeSender(sender);
  const dom = domainOf(canon);
  for (const raw of neverTouch) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry.includes('@')) {
      if (entry === canon) return true;
    } else {
      if (dom === entry) return true;
      if (canon.endsWith('.' + entry)) return true;
    }
  }
  return false;
}

const SYSTEM_PROMPT = `You triage email senders for an operator drowning in unread mail.

For each sender below, classify into EXACTLY ONE bucket:

- "archive" — bulk newsletter, notification, known automated sender, receipt.
  The user clearly doesn't read these but might want to find them later.
- "trash"   — clear marketing, dead newsletter, spammy outreach, or junk.
  No reason to keep these around.
- "keep"    — could matter to a human (direct correspondence, work, anything
  that even might need a reply). When unsure, choose "keep".

Output ONLY valid JSON in this exact shape:

{ "decisions": [ { "sender": "<sender string verbatim>", "action": "archive" | "trash" | "keep" } ] }

Rules:
- Include exactly one decision per sender provided.
- Prefer "keep" when in doubt. False archives are annoying; false trashes are dangerous.`;

function userPromptForGroups(groups: SenderGroup[]): string {
  const lines = groups.map((g) => {
    const subjects = g.exampleSubjects
      .slice(0, 3)
      .map((s) => `    - ${s}`)
      .join('\n');
    return `Sender: ${g.sender}\n  Message count in batch: ${g.totalCount}\n  Example subjects:\n${subjects}`;
  });
  return `Senders to classify:\n\n${lines.join('\n\n')}`;
}

function parseClassificationJson(raw: string): Classification {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const obj = JSON.parse(trimmed) as unknown;
  return ClassificationSchema.parse(obj);
}

/**
 * Page through the inbox until we hit `maxMessages` or run out. Returns
 * flat list of summaries we'll cluster downstream.
 */
async function collectMessages(
  inbox: EmailInboxCapability,
  settings: Settings,
  labelId?: string,
): Promise<InboxMessageSummary[]> {
  const collected: InboxMessageSummary[] = [];
  let cursor: string | undefined;
  while (collected.length < settings.maxMessages) {
    const remaining = settings.maxMessages - collected.length;
    const pageSize = Math.min(PAGE_SIZE, remaining);
    const page: ListMessagesResult = await inbox.listMessages({
      unreadOnly: settings.unreadOnly,
      labelId,
      pageSize,
      cursor,
    });
    collected.push(...page.messages);
    if (!page.nextCursor || page.messages.length === 0) break;
    cursor = page.nextCursor;
  }
  return collected.slice(0, settings.maxMessages);
}

function groupBySender(messages: InboxMessageSummary[]): SenderGroup[] {
  const map = new Map<string, SenderGroup>();
  for (const m of messages) {
    const key = canonicalizeSender(m.from);
    let g = map.get(key);
    if (!g) {
      g = { sender: key, ids: [], exampleSubjects: [], totalCount: 0 };
      map.set(key, g);
    }
    g.ids.push(m.id);
    g.totalCount += 1;
    if (g.exampleSubjects.length < 3) g.exampleSubjects.push(m.subject);
  }
  return Array.from(map.values());
}

export default defineAgent({
  manifest: {
    slug: 'inbox-cleanup',
    version: '0.0.2',
    displayName: 'Inbox Cleanup',
    description:
      'Cluster the inbox backlog by sender and sweep bulk noise (archive or trash) under operator-defined safeguards.',
    requiredConnectors: ['llm', 'email-inbox'],
    settingsSchema: SettingsSchema,
    inputSchema: InputSchema,
    schedule: { kind: 'manual' },
    supportedTriggers: ['manual', 'cron'] as const,
  },
  run: async (ctx): Promise<AgentResult> => {
    const settings = ctx.settings;
    const inbox = (await ctx.connector('email-inbox')) as EmailInboxCapability;
    const minGroupSize = settings.minGroupSize;

    // List available folders so the operator can see them in run details,
    // and resolve a folder name to its ID if the `folder` setting is set.
    let availableFolders: Array<{ id: string; name: string }> | undefined;
    let resolvedLabelId: string | undefined;
    if (inbox.listLabels) {
      try {
        availableFolders = await inbox.listLabels();
        if (settings.folder) {
          const needle = settings.folder.trim().toLowerCase();
          const match = availableFolders.find((f) => f.name.toLowerCase() === needle);
          if (match) {
            resolvedLabelId = match.id;
          } else {
            ctx.logger.warn(
              { folder: settings.folder, available: availableFolders.map((f) => f.name) },
              'inbox-cleanup: folder name not found — falling back to inbox',
            );
          }
        }
      } catch (err) {
        ctx.logger.warn({ err }, 'inbox-cleanup: could not list folders (non-fatal)');
      }
    }

    const messages = await collectMessages(inbox, settings, resolvedLabelId);
    if (messages.length === 0) {
      return {
        ok: true,
        summary: 'inbox empty — nothing to sweep',
        details: { scanned: 0, availableFolders },
      };
    }

    const groups = groupBySender(messages);
    const candidateGroups = groups.filter((g) => g.totalCount >= minGroupSize);

    if (candidateGroups.length === 0) {
      return {
        ok: true,
        summary: `scanned ${messages.length} messages; no sender had >= ${minGroupSize} messages — nothing to sweep`,
        details: { scanned: messages.length, groups: groups.length, availableFolders },
      };
    }

    const llm = await resolveLlm(ctx, settings.llm);
    const response = await llm.complete({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPromptForGroups(candidateGroups) }],
    });

    let classification: Classification;
    try {
      classification = parseClassificationJson(response.content);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.error(
        { rawHead: response.content.slice(0, 200), parseError: message },
        'inbox-cleanup.parse_failed',
      );
      return {
        ok: false,
        summary: `model returned unparseable output: ${message}`,
        details: { stopReason: response.stopReason, usage: response.usage },
      };
    }

    const decisionBySender = new Map<string, 'archive' | 'trash' | 'keep'>();
    for (const d of classification.decisions) {
      decisionBySender.set(canonicalizeSender(d.sender), d.action);
    }

    const dryRun = settings.cleanupAction === 'dry-run';
    let archivedCount = 0;
    let trashedCount = 0;
    let keptCount = 0;
    let keptSenders = 0;

    // Bucket ids by action so we can issue one bulk verb per action.
    const archiveIds: string[] = [];
    const trashIds: string[] = [];

    for (const g of candidateGroups) {
      let action = decisionBySender.get(g.sender) ?? 'keep';
      if (senderIsProtected(g.sender, settings.neverTouchSenders)) {
        action = 'keep';
      }
      // If operator has cleanupAction = 'archive', a trash recommendation
      // downgrades to archive (safer). 'trash' allows both. dry-run does
      // neither.
      if (action === 'trash' && settings.cleanupAction === 'archive') {
        action = 'archive';
      }

      if (action === 'keep') {
        keptCount += g.ids.length;
        keptSenders += 1;
        continue;
      }
      if (action === 'archive') {
        archivedCount += g.ids.length;
        archiveIds.push(...g.ids);
      } else if (action === 'trash') {
        trashedCount += g.ids.length;
        trashIds.push(...g.ids);
      }

      await ctx.audit('inbox.cleanup.batch', {
        sender: g.sender,
        count: g.ids.length,
        action,
        dryRun,
      });
    }

    if (!dryRun) {
      if (archiveIds.length > 0) await inbox.archive(archiveIds);
      if (trashIds.length > 0) await inbox.trash(trashIds);
    }

    const verb = dryRun ? 'would sweep' : 'swept';
    return {
      ok: true,
      summary: `${verb} ${archivedCount + trashedCount} messages: ${archivedCount} archived, ${trashedCount} trashed, ${keptSenders} senders kept`,
      details: {
        scanned: messages.length,
        groupsConsidered: candidateGroups.length,
        archived: archivedCount,
        trashed: trashedCount,
        kept: keptCount,
        keptSenders,
        dryRun,
        availableFolders,
        usage: response.usage,
      },
    };
  },
});

export { InputSchema, SettingsSchema };

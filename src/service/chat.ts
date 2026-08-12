import { parseCommand, HELP_TEXT, type ParseCommandOptions } from '../parse/command.js';
import { buildCard, formatViews, type SubmissionCard } from '../render/card.js';
import type { CampaignService } from './campaign.js';

/**
 * Turns an incoming chat message into zero or more things to post back.
 *
 * This is the integration point. The app's message pipeline calls
 * `handleMessage` for every group message; anything that isn't a campaign
 * command returns an empty array and falls through untouched.
 *
 * Responses are data, not rendered strings, so the client controls presentation
 * and the same logic serves web, iOS and Android.
 */

export type ChatResponse =
  /** Post a message visible to the whole chat. */
  | { type: 'text'; text: string }
  /**
   * Show only to the person who sent the command. Errors use this so a
   * mistyped link doesn't clutter the group.
   */
  | { type: 'ephemeral'; text: string; toUserId: string }
  /** Render a submission card in the chat. */
  | { type: 'card'; card: SubmissionCard }
  /** Replace an existing card in place, after a decision. */
  | { type: 'card_update'; card: SubmissionCard };

export interface MessageContext {
  chatId: string;
  userId: string;
  messageId?: string | null;
  /** Whether this user is an admin of this groupchat. */
  isAdmin: boolean;
  /** Display name for the sender, e.g. "@alice". */
  displayName?: string;
}

export interface ChatHandlerOptions extends ParseCommandOptions {
  /** Resolves user ids to display names for card rendering. */
  resolveDisplayName?: (userId: string) => Promise<string> | string;
}

export class ChatHandler {
  constructor(
    private readonly service: CampaignService,
    private readonly opts: ChatHandlerOptions = {},
  ) {}

  async handleMessage(text: string, ctx: MessageContext): Promise<ChatResponse[]> {
    const command = parseCommand(text, this.opts);
    if (!command) return [];

    switch (command.kind) {
      case 'error':
        return [{ type: 'ephemeral', text: command.message, toUserId: ctx.userId }];

      case 'help':
        return [{ type: 'ephemeral', text: HELP_TEXT, toUserId: ctx.userId }];

      case 'submit':
        return this.handleSubmit(command.url, ctx);

      case 'claim_handle': {
        const result = await this.service.claimHandle({
          userId: ctx.userId,
          platform: command.platform,
          handle: command.handle,
        });
        return [
          {
            type: 'ephemeral',
            toUserId: ctx.userId,
            text: result.ok
              ? `Linked @${command.handle} on ${command.platform}. Clips you submit from that account will verify automatically.`
              : result.message,
          },
        ];
      }

      case 'my_stats':
        return this.handleMyStats(ctx);

      case 'leaderboard':
        return this.handleLeaderboard(ctx);

      case 'queue':
        return this.handleQueue(ctx);

      case 'approve':
      case 'decline':
        return this.handleDecision(command, ctx);
    }
  }

  private async handleSubmit(url: string, ctx: MessageContext): Promise<ChatResponse[]> {
    const result = await this.service.submit({
      chatId: ctx.chatId,
      userId: ctx.userId,
      messageId: ctx.messageId ?? null,
      url,
    });

    if (!result.ok) {
      const extra =
        result.code === 'DUPLICATE' && result.existing
          ? ` (${result.existing.canonicalUrl})`
          : '';
      return [{ type: 'ephemeral', text: result.message + extra, toUserId: ctx.userId }];
    }

    const card = buildCard(result.submission, {
      // The card is posted to the chat, so it must render for everyone. The
      // client re-requests it per viewer to decide whether to draw the admin
      // buttons — see docs/05-chat-card-spec.md.
      viewerIsAdmin: false,
      submitterLabel: ctx.displayName ?? (await this.displayName(ctx.userId)),
    });

    const responses: ChatResponse[] = [{ type: 'card', card }];

    if (result.metrics === null) {
      responses.push({
        type: 'ephemeral',
        toUserId: ctx.userId,
        text: "Submitted, but we couldn't read the view count yet. We'll retry — an admin can still review it.",
      });
    }

    return responses;
  }

  private async handleMyStats(ctx: MessageContext): Promise<ChatResponse[]> {
    const campaign = await this.service.campaignForChat(ctx.chatId);
    if (!campaign) {
      return [
        { type: 'ephemeral', text: 'No active campaign in this chat.', toUserId: ctx.userId },
      ];
    }

    const submissions = await this.service.userSubmissions(campaign.id, ctx.userId);
    if (submissions.length === 0) {
      return [
        {
          type: 'ephemeral',
          text: 'You have not submitted any clips yet. Send `/submit <link>` to enter one.',
          toUserId: ctx.userId,
        },
      ];
    }

    const approved = submissions.filter((s) => s.status === 'approved');
    const totalViews = approved.reduce((sum, s) => sum + (s.latestViews ?? 0), 0);
    const lines = [
      `You have ${submissions.length} submission${submissions.length === 1 ? '' : 's'}: ` +
        `${approved.length} approved, ` +
        `${submissions.filter((s) => s.status === 'pending').length} pending, ` +
        `${submissions.filter((s) => s.status === 'declined').length} declined.`,
      `Total views on approved clips: ${formatViews(totalViews)}`,
      '',
      ...submissions
        .slice(0, 10)
        .map((s) => `${statusIcon(s.status)} ${formatViews(s.latestViews)} — ${s.canonicalUrl}`),
    ];

    return [{ type: 'ephemeral', text: lines.join('\n'), toUserId: ctx.userId }];
  }

  private async handleLeaderboard(ctx: MessageContext): Promise<ChatResponse[]> {
    const campaign = await this.service.campaignForChat(ctx.chatId);
    if (!campaign) {
      return [
        { type: 'ephemeral', text: 'No active campaign in this chat.', toUserId: ctx.userId },
      ];
    }

    const rows = await this.service.leaderboard(campaign.id, 10);
    if (rows.length === 0) {
      return [{ type: 'text', text: 'No approved clips yet — be the first.' }];
    }

    const lines = await Promise.all(
      rows.map(async (row, index) => {
        const name = await this.displayName(row.userId);
        return `${index + 1}. ${name} — ${formatViews(row.totalCurrentViews)} across ${row.approvedCount} clip${
          row.approvedCount === 1 ? '' : 's'
        }`;
      }),
    );

    return [{ type: 'text', text: [`${campaign.name} leaderboard`, ...lines].join('\n') }];
  }

  private async handleQueue(ctx: MessageContext): Promise<ChatResponse[]> {
    if (!ctx.isAdmin) {
      return [
        { type: 'ephemeral', text: 'Only admins can view the review queue.', toUserId: ctx.userId },
      ];
    }

    const campaign = await this.service.campaignForChat(ctx.chatId);
    if (!campaign) {
      return [
        { type: 'ephemeral', text: 'No active campaign in this chat.', toUserId: ctx.userId },
      ];
    }

    const pending = await this.service.queue(campaign.id, 20);
    if (pending.length === 0) {
      return [{ type: 'ephemeral', text: 'Queue is clear — nothing pending.', toUserId: ctx.userId }];
    }

    const cards = await Promise.all(
      pending.map(async (submission) =>
        buildCard(submission, {
          viewerIsAdmin: true,
          viewerUserId: ctx.userId,
          submitterLabel: await this.displayName(submission.submitterUserId),
        }),
      ),
    );

    return cards.map((card) => ({ type: 'card', card }));
  }

  private async handleDecision(
    command: { kind: 'approve' | 'decline'; submissionRef: string; reason?: string | null },
    ctx: MessageContext,
  ): Promise<ChatResponse[]> {
    const result = await this.service.decide({
      submissionId: command.submissionRef,
      actor: { userId: ctx.userId, isAdmin: ctx.isAdmin },
      action: command.kind,
      reason: command.kind === 'decline' ? (command.reason ?? null) : null,
    });

    if (!result.ok) {
      return [{ type: 'ephemeral', text: result.message, toUserId: ctx.userId }];
    }

    const card = buildCard(result.submission, {
      viewerIsAdmin: ctx.isAdmin,
      viewerUserId: ctx.userId,
      submitterLabel: await this.displayName(result.submission.submitterUserId),
      deciderLabel: ctx.displayName ?? (await this.displayName(ctx.userId)),
    });

    return [{ type: 'card_update', card }];
  }

  private async displayName(userId: string): Promise<string> {
    if (!this.opts.resolveDisplayName) return `user:${userId}`;
    return this.opts.resolveDisplayName(userId);
  }
}

function statusIcon(status: string): string {
  return status === 'approved' ? '[approved]' : status === 'declined' ? '[declined]' : '[pending]';
}

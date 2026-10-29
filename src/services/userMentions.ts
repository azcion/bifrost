import type { GuildLinkRepository } from '../db/repositories/GuildLinkRepository';
import type { ChannelLinkRepository } from '../db/repositories/ChannelLinkRepository';
import { randomUUID } from 'crypto';
import { AccountLinkService } from './AccountLinkService';

export type MentionPlatform = 'discord' | 'fluxer';
export interface UserMention {
    token: string;
    sourceId: string;
    fallback: string;
}
export interface UserMentionContext {
    platform: MentionPlatform;
    channelId: string;
    users: UserMention[];
}

export function captureUserMention(
    context: UserMentionContext,
    id: string,
    name: string | null
): string {
    // Keep source IDs through sanitization and queue serialization. Resolve only at delivery.
    const marker = randomUUID();
    const token =
        '@' + (context.platform === 'fluxer' ? '\u200B' : '') + marker;
    context.users.push({
        token,
        sourceId: id,
        fallback: '@\u200B' + (name || 'unknown-user'),
    });
    return marker;
}

export class UserMentionService {
    constructor(
        private readonly accounts: AccountLinkService,
        private readonly guilds: GuildLinkRepository,
        private readonly channels: ChannelLinkRepository
    ) {}

    async resolve(
        content: string,
        context: UserMentionContext | undefined,
        destination: MentionPlatform,
        canView: (
            guildId: string,
            channelId: string,
            userId: string
        ) => Promise<boolean>,
        allowPings = true
    ): Promise<{ content: string; users: string[] }> {
        const users: string[] = [];
        content = content.replace(/@(everyone|here)\b/g, '@\u200B$1');
        if (!context || !context.users.length) {
            return { content, users };
        }
        const counterparts = new Map<string, Promise<string | null>>();
        const counterpart = (id: string) => {
            if (!counterparts.has(id)) {
                counterparts.set(
                    id,
                    this.accounts.counterpart(context.platform, id)
                );
            }
            return counterparts.get(id)!;
        };
        const channel =
            context.platform === 'discord'
                ? await this.channels.findByDiscordChannelId(context.channelId)
                : await this.channels.findByFluxerChannelId(context.channelId);
        const guild = channel
            ? await this.guilds.findById(channel.guildLinkId)
            : null;
        const enabled =
            allowPings &&
            context.platform !== destination &&
            guild?.[`${destination}UserMentions`];
        for (const mention of context.users) {
            if (!content.includes(mention.token)) continue;
            let replacement = mention.fallback;
            if (enabled && guild && channel && users.length < 100) {
                const id = await counterpart(mention.sourceId);
                if (
                    id &&
                    (await canView(
                        guild[`${destination}GuildId`],
                        channel[`${destination}ChannelId`],
                        id
                    ))
                ) {
                    replacement = `<@${id}>`;
                    if (!users.includes(id)) users.push(id);
                }
            }
            content = content.split(mention.token).join(replacement);
        }
        return { content, users };
    }
}

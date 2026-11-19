import type { Client as FluxerClient } from '@fluxerjs/core';
import { type Client as DiscordClient, ReactionType } from 'discord.js';
import type {
    MessageReaction,
    ReactionEmoji,
    ReactionMessage,
} from './reconcileReactions';

function emojiIdentifier({ id, name, animated }: ReactionEmoji) {
    return id ? `${animated ? 'a:' : ''}${name}:${id}` : name;
}

export async function fetchDiscordReactionMessage(
    client: DiscordClient<true>,
    channelId: string,
    messageId: string,
    fetchEmojis: ReactionMessage['fetchEmojis']
): Promise<ReactionMessage | null> {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return null;

    const message = await channel.messages.fetch({
        message: messageId,
        force: true,
        cache: false,
    });
    const reactions: MessageReaction[] = [];

    for (const reaction of message.reactions.cache.values()) {
        const { id, name } = reaction.emoji;
        if (!name) continue;

        const users = new Set<string>();
        for (const [type, count] of [
            [ReactionType.Normal, reaction.countDetails.normal],
            [ReactionType.Super, reaction.countDetails.burst],
        ] as const) {
            if (
                count === 0 ||
                (type === ReactionType.Normal && count === 1 && reaction.me)
            ) {
                continue;
            }

            let after: string | undefined;
            do {
                const page = await reaction.users.fetch({ type, after });
                for (const user of page.values()) {
                    if (!user.bot && user.id !== client.user.id)
                        users.add(user.id);
                }
                after = page.size === 100 ? page.lastKey() : undefined;
            } while (after);
        }

        reactions.push({ emoji: { id, name }, users, own: reaction.me });
    }

    return {
        reactions,
        fetchEmojis,
        add: async (emoji) => {
            await message.react(emojiIdentifier(emoji));
        },
        remove: async (emoji) => {
            await message.reactions
                .resolve(emoji.id ?? emoji.name)
                ?.users.remove();
        },
    };
}

export async function fetchFluxerReactionMessage(
    client: FluxerClient,
    channelId: string,
    messageId: string,
    fetchEmojis: ReactionMessage['fetchEmojis']
): Promise<ReactionMessage> {
    const message = await client.channels.fetchMessage(channelId, messageId);
    const reactions: MessageReaction[] = [];

    for (const reaction of message.reactions) {
        const users = new Set<string>();
        if (reaction.count > Number(reaction.me)) {
            let after: string | undefined;
            do {
                const page = await message.fetchReactionUsersPage(
                    reaction.emojiIdentifier,
                    { limit: 100, after }
                );
                for (const user of page.users) {
                    if (!user.bot && user.id !== client.user?.id)
                        users.add(user.id);
                }
                after = page.hasMore
                    ? (page.nextAfter ?? page.users[page.users.length - 1]?.id)
                    : page.users.length === 100
                      ? page.users[page.users.length - 1]?.id
                      : undefined;
            } while (after);
        }

        reactions.push({ emoji: reaction.emoji, users, own: reaction.me });
    }

    return {
        reactions,
        fetchEmojis,
        add: ({ id, name, animated }) =>
            message.react(id ? { id, name, animated } : name),
        remove: ({ id, name, animated }) =>
            message.removeReaction(id ? { id, name, animated } : name),
    };
}

export interface ReactionEmoji {
    id?: string | null;
    name: string;
    animated?: boolean;
}

export interface MessageReaction {
    emoji: ReactionEmoji;
    users: Set<string>;
    own: boolean;
}

export interface ReactionMessage {
    reactions: MessageReaction[];
    fetchEmojis(): Promise<ReactionEmoji[]>;
    add(emoji: ReactionEmoji): Promise<void>;
    remove(emoji: ReactionEmoji): Promise<void>;
}

const fallback = { name: '❄️' };

function emojiKey(emoji: ReactionEmoji) {
    return emoji.id ?? emoji.name.replace(/\uFE0F/g, '');
}

function isEmojiRejected(emoji: ReactionEmoji, error: unknown) {
    if (typeof error !== 'object' || error === null) return false;
    const { code, status, statusCode } = error as {
        code?: unknown;
        status?: number;
        statusCode?: number;
    };
    const responseStatus = status ?? statusCode;
    return (
        code === 10014 ||
        code === 'CUSTOM_EMOJI_NOT_FOUND' ||
        code === 'NOT_A_VALID_UNICODE_EMOJI' ||
        (Boolean(emoji.id) &&
            (responseStatus === 400 || responseStatus === 403))
    );
}

export async function reconcileReactions(
    source: ReactionMessage,
    destination: ReactionMessage,
    counterpart: (userId: string) => Promise<string | null>
) {
    const active = source.reactions.filter(({ users }) => users.size > 0);
    const emojis = active.some(({ emoji }) => emoji.id)
        ? await destination.fetchEmojis()
        : [];
    const desired = new Map<string, ReactionEmoji>();
    const own = new Set(
        destination.reactions
            .filter((reaction) => reaction.own)
            .map(({ emoji }) => emojiKey(emoji))
    );

    for (const { emoji, users } of active) {
        const matches = emoji.id
            ? emojis.filter(({ name }) => name === emoji.name)
            : [emoji];
        const mapped = matches.length === 1 ? matches[0] : undefined;

        if (mapped) {
            const localUsers = new Set(
                destination.reactions
                    .filter(
                        (reaction) =>
                            emojiKey(reaction.emoji) === emojiKey(mapped)
                    )
                    .flatMap((reaction) => Array.from(reaction.users))
            );

            if (localUsers.size) {
                const linkedUsers = await Promise.all(
                    Array.from(users, counterpart)
                );
                if (linkedUsers.every((id) => id && localUsers.has(id))) {
                    continue;
                }
            }
        }

        const mirror = mapped ?? fallback;
        desired.set(emojiKey(mirror), mirror);
    }

    for (const [key, emoji] of desired) {
        if (own.has(key)) continue;
        try {
            await destination.add(emoji);
        } catch (error) {
            if (key === emojiKey(fallback) || !isEmojiRejected(emoji, error)) {
                throw error;
            }
            desired.set(emojiKey(fallback), fallback);
        }
    }

    for (const { emoji, own } of destination.reactions) {
        if (own && !desired.has(emojiKey(emoji))) {
            await destination.remove(emoji);
        }
    }
}

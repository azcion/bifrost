const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { GatewayDispatchEvents, Collection } = require('discord.js');
const { Events } = require('@fluxerjs/core');
const {
    reconcileReactions,
} = require('../dist/services/reactionSync/reconcileReactions');

const wave = { name: '👋' };
const snowflake = { name: '❄️' };
const discordCustom = { id: '1', name: 'xyz' };
const fluxerCustom = { id: '2', name: 'xyz' };
const linked = (id) => Promise.resolve(id === 'tooth' ? 'linked-tooth' : null);

function reaction(emoji, users = [], own = false) {
    return { emoji, users: new Set(users), own };
}

function message(reactions, emojis = []) {
    const added = [];
    const removed = [];
    return {
        reactions,
        added,
        removed,
        fetchEmojis: async () => emojis,
        add: async (emoji) => added.push(emoji),
        remove: async (emoji) => removed.push(emoji),
    };
}

test('mirrors and restores a reaction when a linked user has no local reaction', async () => {
    const source = message([reaction(wave, ['tooth'])]);
    const initial = message([]);
    await reconcileReactions(source, initial, linked);
    assert.deepEqual(initial.added, [wave]);

    const covered = message([reaction(wave, ['linked-tooth'], true)]);
    await reconcileReactions(source, covered, linked);
    assert.deepEqual(covered.removed, [wave]);

    const removedLocally = message([]);
    await reconcileReactions(source, removedLocally, linked);
    assert.deepEqual(removedLocally.added, [wave]);
});

test('keeps the mirror for other remote users until their reactions are removed', async () => {
    const source = message([reaction(wave, ['tooth', 'other'])]);
    const destination = message([reaction(wave, ['linked-tooth'], true)]);
    await reconcileReactions(source, destination, linked);
    assert.deepEqual(destination.removed, []);

    await reconcileReactions(
        message([reaction(wave, [], true)]),
        destination,
        linked
    );
    assert.deepEqual(destination.removed, [wave]);
});

test('uses the destination custom emoji and deduplicates by its destination ID', async () => {
    const source = message([reaction(discordCustom, ['tooth'])]);
    const destination = message([], [fluxerCustom]);
    await reconcileReactions(source, destination, linked);
    assert.deepEqual(destination.added, [fluxerCustom]);

    const covered = message(
        [reaction(fluxerCustom, ['linked-tooth'], true)],
        [fluxerCustom]
    );
    await reconcileReactions(source, covered, linked);
    assert.deepEqual(covered.removed, [fluxerCustom]);
});

test('shares one fallback across unsupported reactions and keeps it separate from a personal snowflake', async () => {
    const first = reaction(discordCustom, ['tooth']);
    const second = reaction({ id: '3', name: 'another' }, ['other']);
    const personal = reaction(snowflake, ['tooth']);
    const destination = message([]);
    await reconcileReactions(
        message([first, second, personal]),
        destination,
        linked
    );
    assert.deepEqual(destination.added, [snowflake]);

    const existing = message([reaction({ name: '❄' }, ['linked-tooth'], true)]);
    await reconcileReactions(message([second, personal]), existing, linked);
    assert.deepEqual(existing.added, []);
    assert.deepEqual(existing.removed, []);
    await reconcileReactions(message([personal]), existing, linked);
    assert.deepEqual(existing.removed, [{ name: '❄' }]);
});

test('falls back when the destination rejects a named custom emoji', async () => {
    const destination = message([], [fluxerCustom]);
    const add = destination.add;
    destination.add = async (emoji) => {
        if (emoji.id)
            throw Object.assign(new Error('Unavailable'), { statusCode: 403 });
        await add(emoji);
    };
    await reconcileReactions(
        message([reaction(discordCustom, ['tooth'])]),
        destination,
        linked
    );
    assert.deepEqual(destination.added, [snowflake]);
});

test('does not turn temporary failures into snowflakes', async () => {
    const destination = message([], [fluxerCustom]);
    destination.add = async () => {
        throw Object.assign(new Error('Unavailable'), { statusCode: 503 });
    };
    await assert.rejects(
        reconcileReactions(
            message([reaction(discordCustom, ['tooth'])]),
            destination,
            linked
        ),
        { statusCode: 503 }
    );
});

const fixture = mkdtempSync(join(tmpdir(), 'bifrost-reactions-'));
Object.assign(process.env, {
    BF_CONFIG_PATH: fixture,
    BF_DISCORD_TOKEN: 'test',
    BF_FLUXER_TOKEN: 'test',
});
after(() => rmSync(fixture, { recursive: true, force: true }));

test(
    'bridges native adds and removals through Discord and Fluxer gateway events',
    { timeout: 5000 },
    async () => {
        const ReactionSyncService =
            require('../dist/services/reactionSync/ReactionSyncService').default;
        const writes = new EventEmitter();
        const discordUsers = new Set(['tooth']);
        const fluxerUsers = new Set();
        let discordOwn = false;
        let fluxerOwn = false;

        const discord = {
            ws: new EventEmitter(),
            user: { id: 'discord-bot' },
            isReady: () => true,
            channels: {
                fetch: async () => ({
                    isTextBased: () => true,
                    messages: {
                        fetch: async ({ force }) => {
                            assert.equal(force, true);
                            const reaction = {
                                emoji: wave,
                                countDetails: {
                                    normal:
                                        discordUsers.size + Number(discordOwn),
                                    burst: 0,
                                },
                                me: discordOwn,
                                users: {
                                    fetch: async () =>
                                        new Collection(
                                            Array.from(discordUsers, (id) => [
                                                id,
                                                { id },
                                            ])
                                        ),
                                    remove: async () => {
                                        discordOwn = false;
                                        writes.emit('discord-remove');
                                    },
                                },
                            };
                            return {
                                reactions: {
                                    cache: new Collection([
                                        [wave.name, reaction],
                                    ]),
                                    resolve: () => reaction,
                                },
                                react: async (emoji) => {
                                    assert.equal(emoji, wave.name);
                                    discordOwn = true;
                                    writes.emit('discord-add');
                                },
                            };
                        },
                    },
                }),
            },
        };
        const fluxer = Object.assign(new EventEmitter(), {
            user: { id: 'fluxer-bot' },
            channels: {
                fetchMessage: async () => ({
                    reactions: [
                        {
                            emoji: wave,
                            emojiIdentifier: wave.name,
                            count: fluxerUsers.size + Number(fluxerOwn),
                            me: fluxerOwn,
                        },
                    ],
                    fetchReactionUsersPage: async () => ({
                        users: Array.from(fluxerUsers, (id) => ({ id })),
                        hasMore: false,
                    }),
                    react: async (emoji) => {
                        assert.equal(emoji, wave.name);
                        fluxerOwn = true;
                        writes.emit('fluxer-add');
                    },
                    removeReaction: async () => {
                        fluxerOwn = false;
                        writes.emit('fluxer-remove');
                    },
                }),
            },
        });
        const pair = {
            id: 'pair',
            discordMessageId: 'discord-message',
            fluxerMessageId: 'fluxer-message',
        };
        const sync = new ReactionSyncService(
            {
                getMessageLinkByDiscordMessageId: async (id) =>
                    id === pair.discordMessageId ? pair : null,
                getMessageLinkByFluxerMessageId: async (id) =>
                    id === pair.fluxerMessageId ? pair : null,
                getChannelLinkById: async () => ({}),
                getGuildLinkById: async () => ({}),
            },
            {
                counterpart: async (_, id) =>
                    ({ tooth: 'linked-tooth', 'linked-tooth': 'tooth' })[id] ??
                    null,
            },
            {},
            {}
        );
        sync.setDiscordClient(discord);
        sync.setFluxerClient(fluxer);

        let write = once(writes, 'fluxer-add');
        discord.ws.emit(GatewayDispatchEvents.MessageReactionAdd, {
            guild_id: 'guild',
            user_id: 'tooth',
            message_id: pair.discordMessageId,
        });
        await write;

        write = once(writes, 'fluxer-remove');
        fluxerUsers.add('linked-tooth');
        fluxer.emit(Events.MessageReactionAddMany, {
            messageId: pair.fluxerMessageId,
            reactions: [{ userId: 'fluxer-bot' }, { userId: 'linked-tooth' }],
        });
        await write;

        write = once(writes, 'discord-add');
        discordUsers.clear();
        discord.ws.emit(GatewayDispatchEvents.MessageReactionRemove, {
            guild_id: 'guild',
            user_id: 'tooth',
            message_id: pair.discordMessageId,
        });
        await write;

        write = once(writes, 'discord-remove');
        fluxerUsers.clear();
        fluxer.emit(Events.MessageReactionRemoveAll, {
            messageId: pair.fluxerMessageId,
        });
        await write;
    }
);

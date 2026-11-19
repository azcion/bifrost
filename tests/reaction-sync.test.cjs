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
    BF_DISCORD_OWNER_ID: 'owner',
    BF_DB_DIALECT:
        process.env.ACCOUNT_LINK_TEST_POSTGRES === '1' ? 'postgres' : 'sqlite',
});
if (process.env.ACCOUNT_LINK_TEST_POSTGRES === '1')
    Object.assign(process.env, {
        BF_DB_HOST: '127.0.0.1',
        BF_DB_PORT: '55439',
        BF_DB_NAME: 'bifrost_reactions_test',
        BF_DB_USER: 'postgres',
        BF_DB_PASS: 'test-only',
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
        const guild = {
            id: 'guild',
            discordReactionSync: false,
            fluxerReactionSync: true,
        };

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
                getGuildLinkById: async () => guild,
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

        discordUsers.clear();
        const discordRemove = {
            guild_id: 'guild',
            user_id: 'tooth',
            message_id: pair.discordMessageId,
        };
        discord.ws.emit(
            GatewayDispatchEvents.MessageReactionRemove,
            discordRemove
        );
        await new Promise((resolve) => setTimeout(resolve, 350));
        assert.equal(discordOwn, false);

        guild.discordReactionSync = true;
        write = once(writes, 'discord-add');
        discord.ws.emit(
            GatewayDispatchEvents.MessageReactionRemove,
            discordRemove
        );
        await write;

        write = once(writes, 'discord-remove');
        fluxerUsers.clear();
        fluxer.emit(Events.MessageReactionRemoveAll, {
            messageId: pair.fluxerMessageId,
        });
        await write;
    }
);

test('reaction settings default off, persist independently and require destination permission', async () => {
    const sequelize = require('../dist/db/sequelize').default;
    const migrator = require('../dist/db/migrator').default;
    const {
        SequelizeGuildLinkRepository,
    } = require('../dist/db/sequelizerepos/SequelizeGuildLinkRepository');
    const {
        CachedGuildLinkRepository,
    } = require('../dist/db/cachedrepos/CachedGuildLinkRepository');
    const { LinkService } = require('../dist/services/LinkService');
    const { createGuildsRouter } = require('../dist/web/routes/guilds');
    const id = '00000000-0000-4000-8000-000000000007';
    const repository = new CachedGuildLinkRepository(
        new SequelizeGuildLinkRepository(),
        60
    );
    const router = createGuildsRouter({
        linkService: new LinkService(repository),
        fluxerClientRef: {},
    });
    const request = (method, session, body) =>
        new Promise((resolve, reject) =>
            router.handle(
                {
                    method,
                    url: `/guild-links/${id}/reactions`,
                    session,
                    body,
                    headers: {},
                },
                {
                    statusCode: 200,
                    status(code) {
                        this.statusCode = code;
                        return this;
                    },
                    json(body) {
                        resolve({ status: this.statusCode, body });
                    },
                    end() {
                        resolve({ status: this.statusCode });
                    },
                },
                reject
            )
        );

    try {
        await migrator.up({ to: '00006-add-mass-mention-settings.js' });
        await sequelize.getQueryInterface().bulkInsert('guild_links', [
            {
                id,
                discordGuildId: '10',
                fluxerGuildId: '20',
                createdAt: new Date(),
            },
        ]);
        await migrator.up();
        const manager = {
            discord: {
                id: 'manager',
                guilds: [{ id: '10', permissions: '32' }],
            },
        };
        const owner = { discord: { id: 'owner' } };
        assert.equal((await request('GET', {})).status, 403);
        assert.deepEqual((await request('GET', manager)).body, {
            discord: { enabled: false, canManage: true },
            fluxer: { enabled: false, canManage: false },
        });
        assert.equal(
            (
                await request('PATCH', manager, {
                    platform: 'fluxer',
                    enabled: true,
                })
            ).status,
            403
        );
        assert.equal(
            (
                await request('PATCH', manager, {
                    platform: 'discord',
                    enabled: 'yes',
                })
            ).status,
            400
        );
        assert.equal(
            (
                await request('PATCH', manager, {
                    platform: 'discord',
                    enabled: true,
                })
            ).status,
            204
        );
        assert.equal(
            (await repository.findByDiscordGuildId('10')).discordReactionSync,
            true
        );
        assert.equal(
            (await repository.findByFluxerGuildId('20')).fluxerReactionSync,
            false
        );
        assert.equal(
            (
                await request('PATCH', owner, {
                    platform: 'fluxer',
                    enabled: true,
                })
            ).status,
            204
        );
        assert.equal(
            (
                await request('PATCH', manager, {
                    platform: 'discord',
                    enabled: false,
                })
            ).status,
            204
        );
        const settings = (await request('GET', owner)).body;
        assert.equal(settings.discord.enabled, false);
        assert.equal(settings.fluxer.enabled, true);

        await migrator.down();
        await migrator.up();
        const fresh = await new SequelizeGuildLinkRepository().create(
            '30',
            '40'
        );
        assert.equal(fresh.discordReactionSync, false);
        assert.equal(fresh.fluxerReactionSync, false);
    } finally {
        await sequelize.close();
    }
});

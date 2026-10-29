const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-mentions-'));
Object.assign(process.env, {
    BF_CONFIG_PATH: fixture,
    BF_DISCORD_TOKEN: 'test',
    BF_FLUXER_TOKEN: 'test',
    BF_DISCORD_OWNER_ID: '111',
    BF_FLUXER_OWNER_ID: '222',
    BF_DB_DIALECT:
        process.env.ACCOUNT_LINK_TEST_POSTGRES === '1' ? 'postgres' : 'sqlite',
});
if (process.env.ACCOUNT_LINK_TEST_POSTGRES === '1')
    Object.assign(process.env, {
        BF_DB_HOST: '127.0.0.1',
        BF_DB_PORT: '55439',
        BF_DB_NAME: 'bifrost_mentions_test',
        BF_DB_USER: 'postgres',
        BF_DB_PASS: 'test-only',
    });
const sequelize = require('../dist/db/sequelize').default;
const { UserMentionService } = require('../dist/services/userMentions');
const { AccountLinkService } = require('../dist/services/AccountLinkService');
const {
    SequelizeAccountLinkRepository,
} = require('../dist/db/sequelizerepos/SequelizeAccountLinkRepository');
const {
    SequelizeGuildLinkRepository,
} = require('../dist/db/sequelizerepos/SequelizeGuildLinkRepository');
const {
    SequelizeChannelLinkRepository,
} = require('../dist/db/sequelizerepos/SequelizeChannelLinkRepository');
const { WebhookService } = require('../dist/services/WebhookService');
const { toSerializable } = require('../dist/services/MessageQueueService');
const guilds = new SequelizeGuildLinkRepository();
const accounts = new AccountLinkService(new SequelizeAccountLinkRepository());
let guild, channel;
after(async () => {
    await sequelize.close();
    fs.rmSync(fixture, { recursive: true, force: true });
});

test('migration upgrades existing pairs with independent disabled defaults', async () => {
    const context = sequelize.getQueryInterface();
    for (const name of [
        '00001-baseline',
        '00002-add-channel-link-indexes',
        '00003-create-global-account-links',
    ])
        await require(`../dist/db/migrations/${name}`).up({ context });
    await context.bulkInsert('guild_links', [
        {
            id: '00000000-0000-4000-8000-000000000001',
            discordGuildId: '10',
            fluxerGuildId: '20',
            createdAt: new Date(),
        },
    ]);
    const massMigration = require('../dist/db/migrations/00006-add-mass-mention-settings');
    await massMigration.up({ context });
    const migration = require('../dist/db/migrations/00005-add-user-mention-settings');
    await migration.up({ context });
    guild = { id: '00000000-0000-4000-8000-000000000001' };
    const [defaults] = await sequelize.query(
        'SELECT "discordUserMentions", "fluxerUserMentions" FROM guild_links'
    );
    assert.equal(!!defaults[0].discordUserMentions, false);
    assert.equal(!!defaults[0].fluxerUserMentions, false);
    await migration.down({ context });
    await migration.up({ context });
    await guilds.setMentionSetting(guild.id, 'discord', true);
    await guilds.setMentionSetting(guild.id, 'discord', false);
    channel = await new SequelizeChannelLinkRepository().create({
        guildLinkId: guild.id,
        discordChannelId: '30',
        fluxerChannelId: '40',
        discordWebhookId: '50',
        discordWebhookToken: 'fixture',
        fluxerWebhookId: '60',
        fluxerWebhookToken: 'fixture',
    });
});

function request(router, method, session = {}, body) {
    return new Promise((resolve, reject) =>
        router.handle(
            {
                method,
                url: `/guild-links/${guild.id}/mentions`,
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
}
test('settings authorize only destination managers or owner and validate bodies', async () => {
    const { createGuildsRouter } = require('../dist/web/routes/guilds');
    const router = createGuildsRouter({
        linkService: {
            getGuildLinkById: (id) => guilds.findById(id),
            setMentionSetting: (...args) => guilds.setMentionSetting(...args),
        },
        webhookService: {},
        discordClient: {},
        fluxerClientRef: {},
    });
    const discord = {
        discord: { id: '333', guilds: [{ id: '10', permissions: '32' }] },
    };
    const fluxer = {
        fluxer: { id: '444', guilds: [{ id: '20', permissions: '32' }] },
    };
    assert.equal((await request(router, 'GET')).status, 403);
    assert.equal(
        (
            await request(router, 'PATCH', discord, {
                platform: 'fluxer',
                enabled: true,
            })
        ).status,
        403
    );
    assert.equal(
        (
            await request(router, 'PATCH', fluxer, {
                platform: 'discord',
                enabled: true,
            })
        ).status,
        403
    );
    assert.equal(
        (
            await request(router, 'PATCH', discord, {
                platform: 'discord',
                enabled: 'true',
            })
        ).status,
        400
    );
    assert.equal(
        (
            await request(router, 'PATCH', discord, {
                platform: 'discord',
                enabled: true,
            })
        ).status,
        204
    );
    const result = await request(router, 'GET', discord);
    assert.deepEqual(result.body, {
        discord: { enabled: true, massEnabled: false, canManage: true },
        fluxer: { enabled: false, massEnabled: false, canManage: false },
    });
    assert.equal(
        (
            await request(
                router,
                'PATCH',
                { discord: { id: '111' } },
                { platform: 'fluxer', enabled: true }
            )
        ).status,
        204
    );
});

const payloads = {};
test('both transformers preserve tag IDs, plain names and non-pinging reply previews', async () => {
    for (const platform of ['discord', 'fluxer']) {
        const discord = platform === 'discord';
        const Transformer = require(
            `../dist/services/messageTransformer/${discord ? 'Discord' : 'Fluxer'}MessageTransformer`
        ).default;
        const sourceId = discord ? '123' : '456';
        const users = new Map([[sourceId, { username: 'source-name' }]]);
        const message = {
            content: `<@${sourceId}> <@!${sourceId}> @typed @everyone <@&789>`,
            channelId: discord ? '30' : '40',
            client: { users: discord ? { cache: users } : users },
            author: { username: 'sender', avatarURL: () => null },
            attachments: [],
            stickers: [],
            embeds: [],
            guild: null,
        };
        if (!discord)
            message.referencedMessage = {
                ...message,
                referencedMessage: undefined,
            };
        const payload = await new Transformer().transformMessage(message);
        assert.equal(payload.userMentions.users.length, 2);
        if (!discord)
            assert.ok(
                !JSON.stringify(payload.embeds).includes(
                    payload.userMentions.users[0].token
                )
            );
        payloads[platform] = JSON.parse(
            JSON.stringify(toSerializable(payload))
        );
    }
});

test('delivery rechecks mapping, destination toggle and channel access after serialization', async () => {
    const link = await accounts.create('123', '456');
    const service = new UserMentionService(
        accounts,
        guilds,
        new SequelizeChannelLinkRepository()
    );
    for (const source of ['discord', 'fluxer']) {
        const destination = source === 'discord' ? 'fluxer' : 'discord';
        const payload = payloads[source];
        const target = source === 'discord' ? '456' : '123';
        let checks = 0;
        const canView = async (guildId, channelId, userId) => {
            checks++;
            assert.equal(guildId, destination === 'discord' ? '10' : '20');
            assert.equal(channelId, destination === 'discord' ? '30' : '40');
            assert.equal(userId, target);
            return true;
        };
        let result = await service.resolve(
            payload.content,
            payload.userMentions,
            destination,
            canView
        );
        assert.ok(result.content.includes(`<@${target}>`));
        assert.deepEqual(result.users, [target]);
        assert.ok(checks > 0);
        result = await service.resolve(
            payload.content,
            payload.userMentions,
            destination,
            async () => false
        );
        assert.deepEqual(result.users, []);
        assert.ok(result.content.includes('@\u200Bsource-name'));
        await guilds.setMentionSetting(guild.id, destination, false);
        result = await service.resolve(
            payload.content,
            payload.userMentions,
            destination,
            canView
        );
        assert.deepEqual(result.users, []);
        await guilds.setMentionSetting(guild.id, destination, true);
        result = await service.resolve(
            payload.content,
            payload.userMentions,
            destination,
            canView,
            false
        );
        assert.deepEqual(result.users, []);
    }
    await accounts.remove(link.id);
    const result = await service.resolve(
        payloads.discord.content,
        payloads.discord.userMentions,
        'fluxer',
        async () => true
    );
    assert.deepEqual(result.users, []);
    assert.ok(!result.content.includes('<@456>'));
});

test('webhooks explicitly suppress mass, role and reply pings on sends and edits', async () => {
    const service = new WebhookService(
        new UserMentionService(
            accounts,
            guilds,
            new SequelizeChannelLinkRepository()
        )
    );
    const data = {
        content: '@everyone @here <@&123> @typed',
        username: 'sender',
        avatarURL: '',
    };
    const sent = [];
    const webhook = {
        send: async (payload) => {
            sent.push(payload);
            return { id: '1' };
        },
        editMessage: async (_, payload) => sent.push(payload),
        id: '1',
        token: 'fixture',
        client: { rest: { patch: async (_, { body }) => sent.push(body) } },
    };
    await service.sendMessageViaDiscordWebhook(webhook, data);
    await service.sendMessageViaFluxerWebhook(webhook, data);
    await service.editMessageViaDiscordWebhook(webhook, '1', data);
    await service.editMessageViaFluxerWebhook(webhook, '1', data);
    for (const payload of sent.slice(0, 3))
        assert.deepEqual(payload.allowedMentions, {
            parse: [],
            users: [],
            repliedUser: false,
        });
    assert.deepEqual(sent[3].allowed_mentions, {
        parse: [],
        users: [],
        replied_user: false,
    });
});

test('webhook delivery emits only mapped users with destination channel access', async () => {
    await accounts.create('123', '456');
    const service = new WebhookService(
        new UserMentionService(
            accounts,
            guilds,
            new SequelizeChannelLinkRepository()
        )
    );
    let viewable = true;
    const { GuildChannel } = require('@fluxerjs/core');
    const cachedFluxerChannel = Object.create(GuildChannel.prototype);
    cachedFluxerChannel.viewable = true;
    cachedFluxerChannel.guildId = '20';
    const fluxerChannel = Object.create(GuildChannel.prototype);
    fluxerChannel.viewable = true;
    fluxerChannel.guildId = '20';
    service.setDiscordClient({
        rest: { get: async () => ({ roles: [] }) },
        guilds: {
            fetch: async () => ({
                ownerId: 'owner',
                roles: { fetch: async () => new Map([['10', {}]]) },
                members: {
                    fetch: async () => ({
                        roles: { cache: new Map([['10', {}]]) },
                    }),
                },
                channels: {
                    fetch: async () => ({
                        permissionsFor: () => ({ has: () => viewable }),
                    }),
                },
            }),
        },
    });
    service.setFluxerClient({
        guilds: {
            fetch: async () => ({
                ownerId: 'owner',
                fetchRoles: async () => [{ id: '20' }],
                fetchMember: async () => ({
                    roles: { roleIds: [] },
                    permissionsIn: (channel) => ({
                        has: () => channel.viewable,
                    }),
                }),
            }),
        },
        channels: {
            fetch: async (id, options) =>
                options?.force ? fluxerChannel : cachedFluxerChannel,
        },
    });
    for (const source of ['discord', 'fluxer']) {
        const sent = [];
        const webhook = {
            send: async (data) => {
                sent.push(data);
                return { id: '1' };
            },
        };
        const send =
            source === 'discord'
                ? 'sendMessageViaFluxerWebhook'
                : 'sendMessageViaDiscordWebhook';
        await service[send](webhook, { ...payloads[source], embeds: [] });
        const id = source === 'discord' ? '456' : '123';
        assert.ok(sent[0].content.includes(`<@${id}>`));
        assert.deepEqual(sent[0].allowedMentions, {
            parse: [],
            users: [id],
            repliedUser: false,
        });
        viewable = false;
        fluxerChannel.viewable = false;
        await service[send](webhook, { ...payloads[source], embeds: [] });
        assert.deepEqual(sent[1].allowedMentions.users, []);
        viewable = true;
        fluxerChannel.viewable = true;
    }
    for (const row of await accounts.list()) await accounts.remove(row.id);
});

test('permission lookups are reused only within one delivery', async () => {
    const calls = { guild: 0, roles: 0, member: 0, channel: 0, rest: 0 };
    let allowed = true;
    const service = new WebhookService({
        resolve: async (content, context, destination, canView, allowPings) => {
            const first = await canView('10', 'channel', 'user');
            const repeated = await canView('10', 'channel', 'user');
            return {
                content,
                users: first && repeated ? ['user'] : [],
                everyone: false,
            };
        },
    });
    const guild = {
        ownerId: 'owner',
        roles: {
            fetch: async () => {
                calls.roles++;
                return new Map([['10', {}]]);
            },
        },
        members: {
            fetch: async () => {
                calls.member++;
                return { roles: { cache: new Map([['10', {}]]) } };
            },
        },
        channels: {
            fetch: async () => {
                calls.channel++;
                return { permissionsFor: () => ({ has: () => allowed }) };
            },
        },
    };
    service.setDiscordClient({
        guilds: {
            fetch: async () => {
                calls.guild++;
                return guild;
            },
        },
        rest: {
            get: async () => {
                calls.rest++;
                return { roles: [] };
            },
        },
    });
    const sent = [];
    const webhook = {
        send: async (payload) => {
            sent.push(payload);
            return { id: '1' };
        },
    };
    const data = { content: 'hello', username: 'sender', avatarURL: '' };
    await service.sendMessageViaDiscordWebhook(webhook, data);
    assert.deepEqual(calls, {
        guild: 1,
        roles: 1,
        member: 1,
        channel: 1,
        rest: 1,
    });
    assert.deepEqual(sent[0].allowedMentions.users, ['user']);
    allowed = false;
    await service.sendMessageViaDiscordWebhook(webhook, data);
    assert.deepEqual(calls, {
        guild: 2,
        roles: 2,
        member: 2,
        channel: 2,
        rest: 2,
    });
    assert.deepEqual(sent[1].allowedMentions.users, []);
    assert.deepEqual(sent[1].allowedMentions.parse, []);
});

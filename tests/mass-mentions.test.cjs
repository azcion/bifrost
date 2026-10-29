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
        BF_DB_NAME: 'bifrost_mass_mentions_test',
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
    const massMigration = require('../dist/db/migrations/00006-add-mass-mention-settings');
    await massMigration.up({ context });
    assert.equal((await guilds.findById(guild.id)).discordUserMentions, true);
    assert.equal((await guilds.findById(guild.id)).discordMassMentions, false);
    assert.equal((await guilds.findById(guild.id)).fluxerMassMentions, false);
    await massMigration.down({ context });
    await massMigration.up({ context });
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
test('mass settings are independent and require destination authorization', async () => {
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
    const manager = {
        discord: { id: '333', guilds: [{ id: '10', permissions: '32' }] },
    };
    assert.equal(
        (
            await request(router, 'PATCH', manager, {
                platform: 'fluxer',
                kind: 'mass',
                enabled: true,
            })
        ).status,
        403
    );
    assert.equal(
        (
            await request(router, 'PATCH', manager, {
                platform: 'discord',
                kind: 'unknown',
                enabled: true,
            })
        ).status,
        400
    );
    assert.equal(
        (
            await request(router, 'PATCH', manager, {
                platform: 'discord',
                kind: 'mass',
                enabled: true,
            })
        ).status,
        204
    );
    const settings = (await request(router, 'GET', manager)).body;
    assert.equal(settings.discord.massEnabled, true);
    assert.equal(settings.fluxer.massEnabled, false);
    await guilds.setMentionSetting(guild.id, 'discord', false, 'mass');
});

test('mass pings require current linked sender permissions in both channels in either direction', async () => {
    const link = await accounts.create('123', '456');
    const service = new UserMentionService(
        accounts,
        guilds,
        new SequelizeChannelLinkRepository()
    );
    const { captureMassMentions } = require('../dist/services/userMentions');
    for (const source of ['discord', 'fluxer']) {
        const destination = source === 'discord' ? 'fluxer' : 'discord';
        await guilds.setMentionSetting(guild.id, destination, false);
        const context = {
            platform: source,
            channelId: source === 'discord' ? '30' : '40',
            senderId: source === 'discord' ? '123' : '456',
            users: [],
        };
        const content = captureMassMentions(
            '@everyone @here <@&789> @everyoneElse',
            context
        );
        const queued = JSON.parse(JSON.stringify({ content, context }));
        let permitted = { discord: true, fluxer: true };
        const checks = [];
        const check = async (platform, guildId, channelId, userId) => {
            checks.push(platform);
            assert.equal(guildId, platform === 'discord' ? '10' : '20');
            assert.equal(channelId, platform === 'discord' ? '30' : '40');
            assert.equal(userId, platform === 'discord' ? '123' : '456');
            return permitted[platform];
        };
        const resolve = (allow = true) =>
            service.resolve(
                queued.content,
                queued.context,
                destination,
                async () => true,
                allow,
                check
            );
        assert.equal((await resolve()).everyone, false);
        await guilds.setMentionSetting(guild.id, destination, true, 'mass');
        let result = await resolve();
        assert.equal(result.everyone, true);
        assert.ok(result.content.startsWith('@everyone @here '));
        assert.deepEqual(result.users, []);
        assert.deepEqual(checks, [source, destination]);
        for (const denied of [source, destination]) {
            permitted[denied] = false;
            result = await resolve();
            assert.equal(result.everyone, false);
            assert.ok(result.content.startsWith('@\u200Beveryone @\u200Bhere'));
            permitted[denied] = true;
        }
        assert.equal((await resolve(false)).everyone, false);
        assert.equal(
            (
                await service.resolve(
                    content,
                    context,
                    destination,
                    async () => true,
                    true,
                    async () => false
                )
            ).everyone,
            false
        );
        await guilds.setMentionSetting(guild.id, destination, false, 'mass');
        assert.equal((await resolve()).everyone, false);
        await guilds.setMentionSetting(guild.id, destination, true, 'mass');
        await accounts.remove((await accounts.list())[0].id);
        assert.equal((await resolve()).everyone, false);
        await accounts.create('123', '456');
    }
    for (const row of await accounts.list()) await accounts.remove(row.id);
});

test('mass source tokens survive both transformers and legacy text never enables mass pings', async () => {
    for (const platform of ['discord', 'fluxer']) {
        const discord = platform === 'discord';
        const Transformer = require(
            `../dist/services/messageTransformer/${discord ? 'Discord' : 'Fluxer'}MessageTransformer`
        ).default;
        const payload = await new Transformer().transformMessage({
            content: '@everyone @here',
            channelId: discord ? '30' : '40',
            author: {
                id: discord ? '123' : '456',
                username: 'sender',
                avatarURL: () => null,
            },
            client: {},
            guild: null,
            attachments: [],
            stickers: [],
            embeds: [],
        });
        assert.equal(payload.userMentions.senderId, discord ? '123' : '456');
        assert.deepEqual(
            payload.userMentions.mass.map((m) => m.tag),
            ['everyone', 'here']
        );
        const result = await new UserMentionService(
            accounts,
            guilds,
            new SequelizeChannelLinkRepository()
        ).resolve(
            payload.content,
            payload.userMentions,
            discord ? 'fluxer' : 'discord',
            async () => true
        );
        assert.equal(result.everyone, false);
        assert.equal(result.content, '@\u200Beveryone @\u200Bhere');
    }
    const result = await new UserMentionService(
        accounts,
        guilds,
        new SequelizeChannelLinkRepository()
    ).resolve('@everyone @here', undefined, 'discord', async () => true);
    assert.equal(result.everyone, false);
    assert.equal(result.content, '@\u200Beveryone @\u200Bhere');
});

test('webhook mass parsing follows sender permissions, including channel visibility and lookup failures', async () => {
    await accounts.create('123', '456');
    const { GuildChannel } = require('@fluxerjs/core');
    const { PermissionFlags } = require('@fluxerjs/util');
    const { PermissionFlagsBits } = require('discord.js');
    const fluxerChannel = Object.create(GuildChannel.prototype);
    fluxerChannel.guildId = '20';
    let permission = { discord: true, fluxer: true };
    let visible = true;
    let unavailable = false;
    const service = new WebhookService(
        new UserMentionService(
            accounts,
            guilds,
            new SequelizeChannelLinkRepository()
        )
    );
    service.setDiscordClient({
        rest: { get: async () => ({ roles: [] }) },
        guilds: {
            fetch: async () => ({
                ownerId: 'owner',
                roles: { fetch: async () => new Map([['10', {}]]) },
                members: {
                    fetch: async () => {
                        if (unavailable) throw Error('Unavailable');
                        return { roles: { cache: new Map([['10', {}]]) } };
                    },
                },
                channels: {
                    fetch: async () => ({
                        permissionsFor: () => ({
                            has: (flag) =>
                                flag === PermissionFlagsBits.ViewChannel
                                    ? visible
                                    : permission.discord,
                        }),
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
                    permissionsIn: () => ({
                        has: (flag) =>
                            flag === PermissionFlags.ViewChannel
                                ? visible
                                : permission.fluxer,
                    }),
                }),
            }),
        },
        channels: {
            fetch: async (id, options) => {
                assert.equal(id, '40');
                assert.deepEqual(options, { force: true });
                return fluxerChannel;
            },
        },
    });
    const { captureMassMentions } = require('../dist/services/userMentions');
    for (const source of ['discord', 'fluxer']) {
        const destination = source === 'discord' ? 'fluxer' : 'discord';
        const context = {
            platform: source,
            channelId: source === 'discord' ? '30' : '40',
            senderId: source === 'discord' ? '123' : '456',
            users: [],
        };
        const data = {
            content: captureMassMentions('@everyone @here', context),
            userMentions: context,
            username: 'sender',
            avatarURL: '',
        };
        await guilds.setMentionSetting(guild.id, destination, true, 'mass');
        const sent = [];
        const webhook = {
            send: async (payload) => {
                sent.push(payload);
                return { id: '1' };
            },
        };
        const send = () =>
            service[
                source === 'discord'
                    ? 'sendMessageViaFluxerWebhook'
                    : 'sendMessageViaDiscordWebhook'
            ](webhook, data);
        await send();
        assert.deepEqual(sent.at(-1).allowedMentions, {
            parse: ['everyone'],
            users: [],
            repliedUser: false,
        });
        assert.equal(sent.at(-1).content, '@everyone @here');
        for (const denied of ['discord', 'fluxer']) {
            permission[denied] = false;
            await send();
            assert.deepEqual(sent.at(-1).allowedMentions.parse, []);
            permission[denied] = true;
        }
        visible = false;
        await send();
        assert.deepEqual(sent.at(-1).allowedMentions.parse, []);
        visible = true;
        unavailable = true;
        await send();
        assert.deepEqual(sent.at(-1).allowedMentions.parse, []);
        unavailable = false;
        await guilds.setMentionSetting(guild.id, destination, false, 'mass');
    }
    for (const row of await accounts.list()) await accounts.remove(row.id);
});

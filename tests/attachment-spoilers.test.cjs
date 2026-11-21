const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { Attachment, WebhookClient } = require('discord.js');
const { Message, MessageAttachmentFlags, Webhook } = require('@fluxerjs/core');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-spoilers-'));
Object.assign(process.env, {
    BF_CONFIG_PATH: fixture,
    BF_DISCORD_TOKEN: 'test',
    BF_FLUXER_TOKEN: 'test',
});
const DiscordMessageTransformer =
    require('../dist/services/messageTransformer/DiscordMessageTransformer').default;
const FluxerMessageTransformer =
    require('../dist/services/messageTransformer/FluxerMessageTransformer').default;
const { WebhookService } = require('../dist/services/WebhookService');
after(() => fs.rmSync(fixture, { recursive: true, force: true }));

test('Discord spoiler images and videos are sent with Fluxer attachment flags', async (t) => {
    const attachments = [
        { filename: 'image.png', flags: 1 << 3 },
        { filename: 'clip.mp4', flags: (1 << 3) | (1 << 2) },
        { filename: 'SPOILER_legacy.png' },
        { filename: 'public.png', flags: 1 << 2 },
    ].map(
        (attachment) =>
            new Attachment({
                ...attachment,
                url: `https://cdn.example.test/${attachment.filename}`,
            })
    );
    const data = await new DiscordMessageTransformer().transformMessage({
        content: '',
        channelId: '1',
        author: { id: '2', username: 'Alice', avatarURL: () => null },
        attachments,
        embeds: [],
    });

    t.mock.method(globalThis, 'fetch', async () => new Response('file'));
    const post = t.mock.fn(async () => ({
        id: '3',
        timestamp: new Date(0).toISOString(),
    }));
    const webhook = Webhook.fromToken(
        { getOrCreateUser: () => ({}), rest: { post } },
        '4',
        'test'
    );
    const service = new WebhookService({
        resolve: async (content) => ({ content, everyone: false, users: [] }),
    });
    await service.sendMessageViaFluxerWebhook(webhook, data);

    const { body } = post.mock.calls[0].arguments[1];
    const spoiler = MessageAttachmentFlags.IS_SPOILER;
    assert.deepEqual(body.attachments, [
        { id: 0, filename: 'image.png', flags: spoiler },
        { id: 1, filename: 'clip.mp4', flags: spoiler },
        { id: 2, filename: 'SPOILER_legacy.png', flags: spoiler },
        { id: 3, filename: 'public.png' },
    ]);
});

test('Fluxer spoiler images and videos are uploaded to Discord with spoiler filenames', async (t) => {
    const files = [
        ['image.png', 'image/png', MessageAttachmentFlags.IS_SPOILER],
        ['clip.mp4', 'video/mp4', MessageAttachmentFlags.IS_SPOILER],
        ['public.png', 'image/png', 0],
    ];
    const message = new Message(
        {
            getOrCreateUser: () => ({
                id: '2',
                username: 'Alice',
                avatarURL: () => null,
            }),
        },
        {
            id: '1',
            channel_id: '2',
            content: '',
            author: { id: '2', username: 'Alice' },
            attachments: files.map(
                ([filename, content_type, flags], index) => ({
                    id: String(index),
                    filename,
                    content_type,
                    flags,
                    url: `https://cdn.example.test/${filename}`,
                })
            ),
        }
    );
    const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } =
        createRequire(require.resolve('discord.js'))('undici');
    const dispatcher = getGlobalDispatcher();
    const downloads = new MockAgent();
    downloads.disableNetConnect();
    setGlobalDispatcher(downloads);
    t.after(async () => {
        setGlobalDispatcher(dispatcher);
        await downloads.close();
    });
    const cdn = downloads.get('https://cdn.example.test');
    for (const [filename, type] of files) {
        cdn.intercept({ path: `/${filename}` }).reply(200, 'file', {
            headers: { 'Content-Type': type },
        });
    }
    const makeRequest = t.mock.fn(
        async () =>
            new Response(JSON.stringify({ id: '3' }), {
                headers: { 'Content-Type': 'application/json' },
            })
    );
    const webhook = new WebhookClient(
        { id: '123456789012345678', token: 'test' },
        { rest: { makeRequest } }
    );
    const service = new WebhookService({
        resolve: async (content) => ({ content, everyone: false, users: [] }),
    });

    const data = await new FluxerMessageTransformer().transformMessage(message);
    assert.deepEqual(
        await service.sendMessageViaDiscordWebhook(webhook, data),
        {
            messageId: '3',
        }
    );
    downloads.assertNoPendingInterceptors();
    assert.equal(makeRequest.mock.callCount(), 1);
    const [, request] = makeRequest.mock.calls[0].arguments;
    assert.equal(request.method, 'POST');
    assert.deepEqual(
        files.map((_, index) => request.body.get(`files[${index}]`).name),
        ['SPOILER_image.png', 'SPOILER_clip.mp4', 'public.png']
    );
});

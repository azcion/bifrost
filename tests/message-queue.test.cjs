const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-queue-'));
Object.assign(process.env, {
    BF_CONFIG_PATH: fixture,
    BF_DISCORD_TOKEN: 'test',
    BF_FLUXER_TOKEN: 'test',
});
const MessageQueueService =
    require('../dist/services/MessageQueueService').default;
const { QueuedMessageModel } = require('../dist/db/models/QueuedMessageModel');
after(() => fs.rmSync(fixture, { recursive: true, force: true }));

test('a pending Discord upload blocks overlapping drains and can retry after failure', async (t) => {
    const started = Promise.withResolvers();
    const upload = Promise.withResolvers();
    const entry = {
        id: 'entry',
        direction: 'fluxer_to_discord',
        sourceMessageId: 'fluxer-message',
        channelLinkId: 'channel',
        payload: JSON.stringify({
            content: '',
            attachments: [{ spoiler: true }],
        }),
        retryCount: 0,
        update: t.mock.fn(async (values) => Object.assign(entry, values)),
        destroy: t.mock.fn(async () => {}),
    };
    const expire = t.mock.method(QueuedMessageModel, 'destroy', async () => 0);
    const find = t.mock.method(QueuedMessageModel, 'findAll', async () => [
        entry,
    ]);
    const queue = new MessageQueueService(300_000);
    const send = t.mock.fn(async () => ({ messageId: 'discord-message' }));
    send.mock.mockImplementationOnce(() => {
        started.resolve();
        return upload.promise;
    });
    const webhookService = {
        getDiscordWebhook: async () => ({}),
        sendMessageViaDiscordWebhook: send,
    };
    const createMessageLink = t.mock.fn(async () => {});
    const linkService = {
        getChannelLinkById: async () => ({
            id: 'channel',
            guildLinkId: 'guild',
        }),
        createMessageLink,
    };

    const firstRun = queue.drain(webhookService, linkService);
    await started.promise;
    await queue.drain(webhookService, linkService);
    assert.equal(expire.mock.callCount(), 1);
    assert.equal(find.mock.callCount(), 1);
    assert.equal(send.mock.callCount(), 1);

    upload.reject(new Error('webhook timed out'));
    await firstRun;
    assert.equal(entry.retryCount, 1);
    assert.equal(entry.destroy.mock.callCount(), 0);

    await queue.drain(webhookService, linkService);
    assert.equal(send.mock.callCount(), 2);
    assert.equal(send.mock.calls[1].arguments[1].attachments[0].spoiler, true);
    assert.deepEqual(createMessageLink.mock.calls[0].arguments[0], {
        discordMessageId: 'discord-message',
        fluxerMessageId: 'fluxer-message',
        guildLinkId: 'guild',
        channelLinkId: 'channel',
    });
    assert.equal(entry.destroy.mock.callCount(), 1);
});

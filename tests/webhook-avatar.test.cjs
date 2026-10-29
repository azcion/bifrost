const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.BF_DISCORD_TOKEN = 'test';
process.env.BF_FLUXER_TOKEN = 'test';
const { WebhookService } = require('../dist/services/WebhookService');

test('Fluxer webhook omits an absent avatar and preserves a valid avatar', async () => {
    const service = new WebhookService({
        resolve: async (content) => ({ content, users: [] }),
    });
    for (const avatar of ['', 'https://example.com/avatar.png']) {
        let sent;
        const webhook = {
            send: async (payload) => {
                sent = payload;
                return { id: '123' };
            },
        };
        await service.sendMessageViaFluxerWebhook(webhook, {
            content: 'test',
            username: 'tester',
            avatarURL: avatar,
        });
        assert.equal(sent.avatarUrl, avatar || undefined);
        assert.equal(
            JSON.parse(JSON.stringify(sent)).avatarUrl,
            avatar || undefined
        );
    }
});

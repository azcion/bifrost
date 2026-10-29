import {
    Client as FluxerClient,
    TextChannel as FluxerTextChannel,
    Webhook as FluxerWebhook,
    MessageAttachmentFlags,
    GuildChannel as FluxerGuildChannel,
    Routes as FluxerRoutes,
} from '@fluxerjs/core';
import {
    AttachmentBuilder,
    Client as DiscordClient,
    TextChannel as DiscordTextChannel,
    WebhookClient,
    PermissionFlagsBits,
    Routes as DiscordRoutes,
    type RESTGetAPIGuildMemberResult,
} from 'discord.js';
import logger from '../utils/logging/logger';
import WebhookEmbed from './WebhookEmbed';

import { PermissionFlags as FluxerPermissionFlags } from '@fluxerjs/util';
import {
    UserMentionContext,
    UserMentionService,
    MentionPlatform,
} from './userMentions';

type DiscordWebhook = WebhookClient;

export type WebhookAttachment = {
    url: string;
    name: string;
    spoiler?: boolean;
};

export type WebhookMessageData = {
    userMentions?: UserMentionContext;
    content: string;
    username: string;
    avatarURL: string;
    attachments?: WebhookAttachment[];
    embeds?: WebhookEmbed[];
};

export class WebhookService {
    constructor(private readonly userMentions: UserMentionService) {}

    private async prepareMentions(
        data: WebhookMessageData,
        destination: MentionPlatform,
        allowPings = true
    ) {
        const lookups = new Map<string, Promise<unknown>>();
        const lookup = <T>(
            key: string,
            fetch: () => Promise<T>
        ): Promise<T> => {
            if (!lookups.has(key)) lookups.set(key, fetch());
            return lookups.get(key) as Promise<T>;
        };
        return this.userMentions.resolve(
            data.content,
            data.userMentions,
            destination,
            (guildId, channelId, userId) =>
                this.hasMentionPermission(
                    destination,
                    guildId,
                    channelId,
                    userId,
                    false,
                    lookup
                ),
            allowPings,
            (platform, guildId, channelId, userId) =>
                this.hasMentionPermission(
                    platform,
                    guildId,
                    channelId,
                    userId,
                    true,
                    lookup
                )
        );
    }

    private async hasMentionPermission(
        platform: MentionPlatform,
        guildId: string,
        channelId: string,
        userId: string,
        mass: boolean,
        lookup: <T>(key: string, fetch: () => Promise<T>) => Promise<T>
    ): Promise<boolean> {
        try {
            if (platform === 'discord') {
                const guild = await lookup(`discord:guild:${guildId}`, () =>
                    this.discordClient!.guilds.fetch({
                        guild: guildId,
                        force: true,
                    })
                );
                if (!guild?.ownerId) return false;
                const roles = await lookup(`discord:roles:${guildId}`, () =>
                    guild.roles.fetch()
                );
                const member = await lookup(
                    `discord:member:${guildId}:${userId}`,
                    () => guild.members.fetch({ user: userId, force: true })
                );
                const channel = await lookup(
                    `discord:channel:${guildId}:${channelId}`,
                    () => guild.channels.fetch(channelId, { force: true })
                );
                // The SDK role cache can retain deleted roles, so compare it with
                // the current REST member and role lists before calculating permissions.
                const currentMember = (await lookup(
                    `discord:rest-member:${guildId}:${userId}`,
                    () =>
                        this.discordClient!.rest.get(
                            DiscordRoutes.guildMember(guildId, userId)
                        )
                )) as RESTGetAPIGuildMemberResult | undefined;
                const roleIds = currentMember?.roles;
                const cachedRoles = member?.roles.cache;
                if (
                    !member ||
                    !Array.isArray(roleIds) ||
                    !cachedRoles ||
                    !roles.has(guildId) ||
                    roleIds.some(
                        (id) => !roles.has(id) || !cachedRoles.has(id)
                    ) ||
                    [...cachedRoles.keys()].some(
                        (id) => id !== guildId && !roleIds.includes(id)
                    )
                )
                    return false;
                const permissions = channel?.permissionsFor(member);
                return (
                    !!permissions?.has(PermissionFlagsBits.ViewChannel) &&
                    (!mass ||
                        permissions.has(PermissionFlagsBits.MentionEveryone))
                );
            }
            const guild = await lookup(`fluxer:guild:${guildId}`, () =>
                this.fluxerClient!.guilds.fetch(guildId, { force: true })
            );
            if (!guild?.ownerId) return false;
            const roles = await lookup(`fluxer:roles:${guildId}`, () =>
                guild.fetchRoles()
            );
            const member = await lookup(
                `fluxer:member:${guildId}:${userId}`,
                () => guild.fetchMember(userId)
            );
            const channel = await lookup(`fluxer:channel:${channelId}`, () =>
                this.fluxerClient!.channels.fetch(channelId, { force: true })
            );
            if (
                !member ||
                !(channel instanceof FluxerGuildChannel) ||
                channel.guildId !== guildId
            )
                return false;
            const roleIds = new Set(roles.map((role) => role.id));
            if (
                !roleIds.has(guildId) ||
                [...member.roles.roleIds].some((id) => !roleIds.has(id))
            )
                return false;
            const permissions = member.permissionsIn(channel);
            return (
                permissions.has(FluxerPermissionFlags.ViewChannel) &&
                (!mass ||
                    permissions.has(FluxerPermissionFlags.MentionEveryone))
            );
        } catch {
            // Missing members and unavailable permissions must not enable notifications.
            return false;
        }
    }

    private discordClient: DiscordClient | null = null;
    private fluxerClient: FluxerClient | null = null;

    setDiscordClient(client: DiscordClient) {
        this.discordClient = client;
    }

    setFluxerClient(client: FluxerClient) {
        this.fluxerClient = client;
    }

    async createDiscordWebhook(
        channelId: string,
        name: string
    ): Promise<{ id: string; token: string }> {
        if (!this.discordClient) {
            throw new Error('Discord client not set in WebhookService');
        }

        try {
            const channel = await this.discordClient.channels.fetch(channelId);
            if (!channel || !(channel instanceof DiscordTextChannel)) {
                throw new Error('Invalid Discord channel');
            }

            const webhook = await channel.createWebhook({ name });
            return { id: webhook.id, token: webhook.token! };
        } catch (error: unknown) {
            logger.error('Error creating Discord webhook:', error);
            throw error;
        }
    }

    async getDiscordWebhook(
        webhookId: string,
        webhookToken: string
    ): Promise<DiscordWebhook | null> {
        if (!this.discordClient) {
            throw new Error('Discord client not set in WebhookService');
        }

        try {
            const webhook = await this.discordClient.fetchWebhook(
                webhookId,
                webhookToken
            );
            if (!webhook) return null;
            const webhookClient = new WebhookClient({
                id: webhookId,
                token: webhookToken,
            });
            return webhookClient;
        } catch (error: unknown) {
            logger.error('Error getting or creating Discord webhook:', error);
            throw error;
        }
    }

    async sendMessageViaDiscordWebhook(
        webhook: DiscordWebhook,
        data: WebhookMessageData
    ): Promise<{ messageId: string }> {
        try {
            const mentions = await this.prepareMentions(data, 'discord', true);
            const files = data.attachments?.map((att) => {
                const attBuilder = new AttachmentBuilder(att.url, {
                    name: att.name,
                });
                if (att.spoiler) attBuilder.setSpoiler(true);
                return attBuilder;
            });

            const { id } = await webhook.send({
                content: mentions.content,
                allowedMentions: {
                    parse: mentions.everyone ? ['everyone'] : [],
                    users: mentions.users,
                    repliedUser: false,
                },
                username: data.username,
                avatarURL: data.avatarURL,
                files,
                embeds:
                    data.embeds?.map((embed) => embed.toDiscordEmbed()) || [],
            });

            return { messageId: id };
        } catch (error: unknown) {
            logger.error('Error sending message via Discord webhook:', error);
            throw error;
        }
    }

    async editMessageViaDiscordWebhook(
        webhook: DiscordWebhook,
        messageId: string,
        data: WebhookMessageData
    ): Promise<void> {
        try {
            const mentions = await this.prepareMentions(data, 'discord', false);
            const files = data.attachments?.map((att) => {
                const attBuilder = new AttachmentBuilder(att.url, {
                    name: att.name,
                });
                if (att.spoiler) attBuilder.setSpoiler(true);
                return attBuilder;
            });

            await webhook.editMessage(messageId, {
                content: mentions.content,
                allowedMentions: {
                    parse: mentions.everyone ? ['everyone'] : [],
                    users: mentions.users,
                    repliedUser: false,
                },
                files,
                embeds:
                    data.embeds?.map((embed) => embed.toDiscordEmbed()) || [],
            });
        } catch (error: unknown) {
            logger.error('Error editing message via Discord webhook:', error);
            throw error;
        }
    }

    async createFluxerWebhook(
        channelId: string,
        name: string
    ): Promise<{ id: string; token: string }> {
        if (!this.fluxerClient) {
            throw new Error('Fluxer client not set in WebhookService');
        }

        try {
            const channel = (await this.fluxerClient.channels.fetch(
                channelId
            )) as FluxerTextChannel;
            const webhook = await channel.createWebhook({ name });
            return { id: webhook.id, token: webhook.token! };
        } catch (error: unknown) {
            logger.error('Error creating Fluxer webhook:', error);
            throw error;
        }
    }

    async deleteDiscordWebhook(
        webhookId: string,
        webhookToken: string
    ): Promise<void> {
        if (!this.discordClient) return;
        try {
            const webhook = await this.discordClient.fetchWebhook(
                webhookId,
                webhookToken
            );
            await webhook.delete();
        } catch (error) {
            logger.error('Error deleting Discord webhook:', error);
            throw error;
        }
    }

    async deleteFluxerWebhook(
        webhookId: string,
        webhookToken: string
    ): Promise<void> {
        if (!this.fluxerClient) return;
        try {
            const webhook = FluxerWebhook.fromToken(
                this.fluxerClient,
                webhookId,
                webhookToken
            );
            await webhook.delete();
        } catch (error) {
            logger.error('Error deleting Fluxer webhook:', error);
            throw error;
        }
    }

    async getFluxerWebhook(
        webhookId: string,
        webhookToken: string
    ): Promise<FluxerWebhook> {
        if (!this.fluxerClient) {
            throw new Error('Fluxer client not set in WebhookService');
        }

        try {
            const webhook = FluxerWebhook.fromToken(
                this.fluxerClient,
                webhookId,
                webhookToken
            );
            return webhook;
        } catch (error: unknown) {
            logger.error('Error getting or creating Fluxer webhook:', error);
            throw error;
        }
    }

    async sendMessageViaFluxerWebhook(
        webhook: FluxerWebhook,
        data: WebhookMessageData
    ): Promise<{ messageId: string }> {
        try {
            const mentions = await this.prepareMentions(data, 'fluxer', true);
            const msg = await webhook.send(
                {
                    content: mentions.content,
                    allowedMentions: {
                        parse: mentions.everyone ? ['everyone'] : [],
                        users: mentions.users,
                        repliedUser: false,
                    },
                    username: data.username,
                    avatarUrl: data.avatarURL || undefined,
                    files:
                        data.attachments?.map((attachment) => ({
                            url: attachment.url,
                            name: attachment.name,
                            filename: attachment.name,
                        })) || [],
                    attachments:
                        data.attachments?.map((attachment, index) => ({
                            id: index,
                            name: attachment.name,
                            filename: attachment.name,
                            flags: attachment.spoiler
                                ? MessageAttachmentFlags.IS_SPOILER
                                : undefined,
                        })) || [],
                    embeds:
                        data.embeds?.map((embed) => embed.toFluxerEmbed()) ||
                        [],
                },
                true
            );

            if (!msg) {
                throw new Error(
                    'Did not receive message object after sending via Fluxer webhook'
                );
            }

            return { messageId: msg.id };
        } catch (error: unknown) {
            logger.error('Error sending message via Fluxer webhook:', error);
            throw error;
        }
    }

    async editMessageViaFluxerWebhook(
        webhook: FluxerWebhook,
        messageId: string,
        data: WebhookMessageData
    ): Promise<void> {
        try {
            const mentions = await this.prepareMentions(data, 'fluxer', false);
            const route =
                FluxerRoutes.webhookExecute(webhook.id, webhook.token!) +
                `/messages/${messageId}`;
            await webhook.client.rest.patch(route, {
                body: {
                    content: mentions.content,
                    allowed_mentions: {
                        parse: mentions.everyone ? ['everyone'] : [],
                        users: mentions.users,
                        replied_user: false,
                    },
                    attachments:
                        data.attachments?.map((attachment, index) => ({
                            id: index,
                            name: attachment.name,
                            filename: attachment.name,
                            flags: attachment.spoiler
                                ? MessageAttachmentFlags.IS_SPOILER
                                : undefined,
                        })) || [],
                    embeds:
                        data.embeds?.map((embed) => embed.toFluxerEmbed()) ||
                        [],
                },
                auth: false,
            });
        } catch (error: unknown) {
            logger.error('Error editing message via Fluxer webhook:', error);
            throw error;
        }
    }
}

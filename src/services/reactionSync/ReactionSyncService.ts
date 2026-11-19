import { Client as FluxerClient, Events as FluxerEvents } from '@fluxerjs/core';
import { Client as DiscordClient, GatewayDispatchEvents } from 'discord.js';
import {
    isFluxerApiBlocked,
    isFluxerApiBlockError,
    markFluxerApiBlocked,
} from '../../utils/fluxerApiGuard';
import logger from '../../utils/logging/logger';
import type { MessageLink } from '../../db/entities/MessageLink';
import { AccountLinkService } from '../AccountLinkService';
import DiscordEntityResolver from '../entityResolver/DiscordEntityResolver';
import FluxerEntityResolver from '../entityResolver/FluxerEntityResolver';
import { LinkService } from '../LinkService';
import {
    fetchDiscordReactionMessage,
    fetchFluxerReactionMessage,
} from './reactionMessages';
import { reconcileReactions } from './reconcileReactions';

type Platform = 'discord' | 'fluxer';

export default class ReactionSyncService {
    private discordClient?: DiscordClient;
    private fluxerClient?: FluxerClient;
    private readonly pending = new Map<string, { dirty: boolean }>();

    constructor(
        private readonly links: LinkService,
        private readonly accounts: AccountLinkService,
        private readonly discordResolver: DiscordEntityResolver,
        private readonly fluxerResolver: FluxerEntityResolver
    ) {}

    setDiscordClient(client: DiscordClient) {
        this.discordClient = client;

        // Dispatches include reactions on messages outside the client's cache.
        const onReaction = (event: {
            guild_id?: string;
            message_id: string;
            user_id?: string;
        }) => {
            if (event.guild_id && event.user_id !== client.user?.id) {
                void this.schedule('discord', event.message_id);
            }
        };
        client.ws.on(GatewayDispatchEvents.MessageReactionAdd, onReaction);
        client.ws.on(GatewayDispatchEvents.MessageReactionRemove, onReaction);
        client.ws.on(
            GatewayDispatchEvents.MessageReactionRemoveAll,
            onReaction
        );
        client.ws.on(
            GatewayDispatchEvents.MessageReactionRemoveEmoji,
            onReaction
        );
    }

    setFluxerClient(client: FluxerClient) {
        this.fluxerClient = client;

        client.on(FluxerEvents.MessageReactionAdd, ({ userId, messageId }) => {
            if (userId !== client.user?.id)
                void this.schedule('fluxer', messageId);
        });
        client.on(
            FluxerEvents.MessageReactionRemove,
            ({ userId, messageId }) => {
                if (userId !== client.user?.id)
                    void this.schedule('fluxer', messageId);
            }
        );
        client.on(
            FluxerEvents.MessageReactionAddMany,
            ({ reactions, messageId }) => {
                if (
                    reactions.some(({ userId }) => userId !== client.user?.id)
                ) {
                    void this.schedule('fluxer', messageId);
                }
            }
        );
        client.on(FluxerEvents.MessageReactionRemoveAll, ({ messageId }) => {
            void this.schedule('fluxer', messageId);
        });
        client.on(FluxerEvents.MessageReactionRemoveEmoji, ({ messageId }) => {
            void this.schedule('fluxer', messageId);
        });
    }

    private async schedule(platform: Platform, messageId: string) {
        try {
            const link = await (platform === 'discord'
                ? this.links.getMessageLinkByDiscordMessageId(messageId)
                : this.links.getMessageLinkByFluxerMessageId(messageId));
            if (!link) return;

            const pending = this.pending.get(link.id);
            if (pending) {
                pending.dirty = true;
                return;
            }

            const work = { dirty: true };
            this.pending.set(link.id, work);
            try {
                do {
                    // Combine bursts of gateway events before reading both messages.
                    await new Promise((resolve) => setTimeout(resolve, 250));
                    work.dirty = false;
                    try {
                        await this.sync(link);
                    } catch (error) {
                        if (isFluxerApiBlockError(error))
                            markFluxerApiBlocked();
                        logger.warn(
                            '[ReactionSync] Failed to reconcile reactions',
                            error
                        );
                    }
                } while (work.dirty);
            } finally {
                this.pending.delete(link.id);
            }
        } catch (error) {
            logger.warn(
                '[ReactionSync] Failed to look up a message link',
                error
            );
        }
    }

    private async sync(link: MessageLink) {
        const discord = this.discordClient;
        const fluxer = this.fluxerClient;
        if (!discord?.isReady() || !fluxer?.user || isFluxerApiBlocked())
            return;

        const [channel, guild] = await Promise.all([
            this.links.getChannelLinkById(link.channelLinkId),
            this.links.getGuildLinkById(link.guildLinkId),
        ]);
        if (
            !channel ||
            !guild ||
            (!guild.discordReactionSync && !guild.fluxerReactionSync)
        )
            return;

        const [discordMessage, fluxerMessage] = await Promise.all([
            fetchDiscordReactionMessage(
                discord,
                channel.discordChannelId,
                link.discordMessageId,
                async () =>
                    (
                        await this.discordResolver.fetchEmojis(
                            guild.discordGuildId
                        )
                    )
                        .filter(
                            ({ available, roles }) =>
                                available !== false &&
                                (!roles.cache.size ||
                                    roles.cache.some((role) =>
                                        role.guild.members.me?.roles.cache.has(
                                            role.id
                                        )
                                    ))
                        )
                        .flatMap(({ id, name, animated }) =>
                            name ? [{ id, name, animated }] : []
                        )
            ),
            fetchFluxerReactionMessage(
                fluxer,
                channel.fluxerChannelId,
                link.fluxerMessageId,
                () => this.fluxerResolver.fetchEmojis(guild.fluxerGuildId)
            ),
        ]);
        if (!discordMessage) return;

        const accountLookups = new Map<string, Promise<string | null>>();
        const counterpart = (platform: Platform, userId: string) => {
            const key = `${platform}:${userId}`;
            const existing = accountLookups.get(key);
            if (existing) return existing;

            const lookup = this.accounts.counterpart(platform, userId);
            accountLookups.set(key, lookup);
            return lookup;
        };

        const current = await this.links.getGuildLinkById(guild.id);
        const results = await Promise.allSettled([
            current?.fluxerReactionSync
                ? reconcileReactions(discordMessage, fluxerMessage, (id) =>
                      counterpart('discord', id)
                  )
                : undefined,
            current?.discordReactionSync
                ? reconcileReactions(fluxerMessage, discordMessage, (id) =>
                      counterpart('fluxer', id)
                  )
                : undefined,
        ]);
        for (const result of results) {
            if (result.status === 'rejected') {
                if (isFluxerApiBlockError(result.reason))
                    markFluxerApiBlocked();
                logger.warn(
                    '[ReactionSync] Failed to mirror reactions',
                    result.reason
                );
            }
        }
    }
}

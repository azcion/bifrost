import { PermissionFlags } from '@fluxerjs/util';
import { PermissionFlagsBits } from 'discord.js';
import { FLUXER_BASE_URL } from './env';

const BASE_BOT_PERMISSIONS = BigInt(536947712);
export const DISCORD_BOT_PERMISSIONS = (
    BASE_BOT_PERMISSIONS | PermissionFlagsBits.AddReactions
).toString();
export const FLUXER_BOT_PERMISSIONS = (
    BASE_BOT_PERMISSIONS |
    PermissionFlags.AddReactions |
    PermissionFlags.UseExternalEmojis
).toString();

export const generateDiscordBotInviteLink = (
    clientId: string,
    permissions: string,
    guildId?: string
) => {
    let url = `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=${permissions}&integration_type=0&scope=bot`;
    if (guildId) {
        url += `&guild_id=${guildId}&disable_guild_select=true`;
    }
    return url;
};

export const generateFluxerBotInviteLink = (
    clientId: string,
    permissions: string,
    guildId?: string
) => {
    const baseUrl =
        FLUXER_BASE_URL?.replace(/\/$/, '') || 'https://web.fluxer.app';
    let url = `${baseUrl}/oauth2/authorize?client_id=${clientId}&scope=bot&permissions=${permissions}`;
    if (guildId) {
        url += `&guild_id=${guildId}&disable_guild_select=true`;
    }
    return url;
};

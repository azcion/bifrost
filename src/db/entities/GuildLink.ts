export interface GuildLink {
    id: string;
    discordGuildId: string;
    fluxerGuildId: string;
    discordAccountPresentationEnabled: boolean;
    fluxerAccountPresentationEnabled: boolean;
    discordUserMentions: boolean;
    fluxerUserMentions: boolean;
    createdAt: Date;
}

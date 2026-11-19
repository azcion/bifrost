export interface GuildLink {
    id: string;
    discordGuildId: string;
    fluxerGuildId: string;
    discordAccountPresentationEnabled: boolean;
    fluxerAccountPresentationEnabled: boolean;
    discordUserMentions: boolean;
    fluxerUserMentions: boolean;
    discordMassMentions: boolean;
    fluxerMassMentions: boolean;
    discordReactionSync: boolean;
    fluxerReactionSync: boolean;
    createdAt: Date;
}

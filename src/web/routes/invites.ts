import { Router } from 'express';
import { DISCORD_APP_ID, FLUXER_APP_ID } from '../../utils/env';
import {
    DISCORD_BOT_PERMISSIONS,
    FLUXER_BOT_PERMISSIONS,
    generateDiscordBotInviteLink,
    generateFluxerBotInviteLink,
} from '../../utils/generateBotInvite';
import type { InviteLinkResponse } from '../types';

const router: Router = Router();

router.get('/invite-link', (req, res) => {
    const { platform, guildId } = req.query;
    if (platform !== 'discord' && platform !== 'fluxer') {
        res.status(400).json({ error: 'platform must be discord or fluxer' });
        return;
    }
    const guildIdParam = typeof guildId === 'string' ? guildId : undefined;

    const url =
        platform === 'discord'
            ? generateDiscordBotInviteLink(
                  DISCORD_APP_ID,
                  DISCORD_BOT_PERMISSIONS,
                  guildIdParam
              )
            : generateFluxerBotInviteLink(
                  FLUXER_APP_ID,
                  FLUXER_BOT_PERMISSIONS,
                  guildIdParam
              );

    const response: InviteLinkResponse = { url };
    res.json(response);
});

export default router;

import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator';

export const up: Migration = async ({ context }) => {
    await context.sequelize.transaction(async (transaction) => {
        for (const field of ['discordReactionSync', 'fluxerReactionSync']) {
            await context.addColumn(
                'guild_links',
                field,
                {
                    type: DataTypes.BOOLEAN,
                    allowNull: false,
                    defaultValue: false,
                },
                { transaction }
            );
        }
    });
};

export const down: Migration = async ({ context }) => {
    await context.sequelize.transaction(async (transaction) => {
        for (const field of ['discordReactionSync', 'fluxerReactionSync']) {
            await context.removeColumn('guild_links', field, { transaction });
        }
    });
};

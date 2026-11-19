import { useUserMentionSettings, useSetUserMentions } from '@/api/client';
import { Switch } from '@/components/ui/switch';
import { toastManager } from '@/components/ui/toast';

export function UserMentionSettings({
    guildLinkId,
}: {
    guildLinkId: string | undefined;
}) {
    const { data, isLoading, error } = useUserMentionSettings(guildLinkId);
    const update = useSetUserMentions(guildLinkId);
    return (
        <section className="flex flex-col gap-4">
            <h2 className="font-medium">Incoming mentions</h2>
            {isLoading && (
                <p className="text-sm text-muted-foreground">
                    Loading mention settings…
                </p>
            )}
            {error && (
                <p role="alert">
                    Could not load mention settings: {error.message}
                </p>
            )}
            {data &&
                (['discord', 'fluxer'] as const).map((platform) => (
                    <div key={platform} className="flex flex-col gap-3">
                        <h3 className="text-sm font-medium">
                            {platform === 'discord' ? 'Discord' : 'Fluxer'}
                        </h3>
                        {(['user', 'mass'] as const).map((kind) => (
                            <div
                                key={kind}
                                className="flex items-center justify-between gap-4"
                            >
                                <label htmlFor={`mentions-${platform}-${kind}`}>
                                    {kind === 'user'
                                        ? 'Allow incoming linked @user pings'
                                        : 'Allow incoming @everyone and @here pings'}
                                </label>
                                <Switch
                                    id={`mentions-${platform}-${kind}`}
                                    checked={
                                        kind === 'user'
                                            ? data[platform].enabled
                                            : data[platform].massEnabled
                                    }
                                    disabled={
                                        !data[platform].canManage ||
                                        update.isPending
                                    }
                                    onCheckedChange={(enabled) =>
                                        update.mutate(
                                            { platform, enabled, kind },
                                            {
                                                onError: (err) =>
                                                    toastManager.add({
                                                        title: 'Could not update mention settings',
                                                        description:
                                                            err.message,
                                                    }),
                                            }
                                        )
                                    }
                                />
                            </div>
                        ))}
                    </div>
                ))}
        </section>
    );
}

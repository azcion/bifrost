import { useReactionSyncSettings, useSetReactionSync } from '@/api/client';
import { Switch } from '@/components/ui/switch';
import { toastManager } from '@/components/ui/toast';

export function ReactionSyncSettings({ guildLinkId }: { guildLinkId: string }) {
    const { data, isLoading, error } = useReactionSyncSettings(guildLinkId);
    const update = useSetReactionSync(guildLinkId);

    return (
        <section className="flex flex-col gap-4">
            <h2 className="font-medium">Incoming reactions</h2>
            {isLoading && (
                <p className="text-sm text-muted-foreground">
                    Loading reaction settings…
                </p>
            )}
            {error && (
                <p role="alert">
                    Could not load reaction settings. {error.message}
                </p>
            )}
            {data &&
                (['discord', 'fluxer'] as const).map((platform) => (
                    <div
                        key={platform}
                        className="flex items-center justify-between gap-4"
                    >
                        <label htmlFor={`reaction-sync-${platform}`}>
                            {platform === 'discord'
                                ? 'Sync reactions to Discord'
                                : 'Sync reactions to Fluxer'}
                        </label>
                        <Switch
                            id={`reaction-sync-${platform}`}
                            checked={data[platform].enabled}
                            disabled={
                                !data[platform].canManage || update.isPending
                            }
                            onCheckedChange={(enabled) =>
                                update.mutate(
                                    { platform, enabled },
                                    {
                                        onError: (err) =>
                                            toastManager.add({
                                                title: 'Could not update reaction settings',
                                                description: err.message,
                                            }),
                                    }
                                )
                            }
                        />
                    </div>
                ))}
            <p className="text-sm text-muted-foreground">
                Only the destination server’s managers or the instance owner can
                change its setting.
            </p>
        </section>
    );
}

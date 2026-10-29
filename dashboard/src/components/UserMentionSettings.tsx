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
            <div>
                <h2 className="font-medium">Linked user mentions</h2>
                <p className="text-sm text-muted-foreground">
                    Allow incoming tags to notify linked accounts in each
                    server. Role, everyone, here, and automatic reply
                    notifications stay disabled.
                </p>
            </div>
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
                    <div
                        key={platform}
                        className="flex items-center justify-between gap-4"
                    >
                        <label htmlFor={`mentions-${platform}`}>
                            Allow incoming linked-user pings on{' '}
                            {platform === 'discord' ? 'Discord' : 'Fluxer'}
                        </label>
                        <Switch
                            id={`mentions-${platform}`}
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
                                                title: 'Could not update mention settings',
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

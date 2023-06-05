import {NodeKit} from '@gravity-ui/nodekit';

declare module '@gravity-ui/nodekit' {
    interface AppConfig {}

    interface AppContextParams {}
}

export const nodekit = new NodeKit({
    config: {
        appPort: 3033,
    },
});

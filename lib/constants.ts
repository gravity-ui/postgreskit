import type {Knex} from 'knex';

import type {ExLogger, PDOptions} from './types';

export const defaultKnexOptions: Knex.Config = {
    client: 'pg',
    pool: {
        min: 2,
        max: 10,
        acquireTimeoutMillis: 40000,
        createTimeoutMillis: 50000,
        idleTimeoutMillis: 45000,
        reapIntervalMillis: 1000,
    },
    acquireConnectionTimeout: 10000,
};

export const defaultDispatcherOptions: PDOptions = {
    healthcheckInterval: 5000,
    healthcheckTimeout: 700,
    suppressStatusLogs: false,
    beforeTerminate: () => Promise.resolve(),
};

export const defaultExLogger: ExLogger = {
    info(...args) {
        // eslint-disable-next-line no-console
        console.log(...args);
    },
    error(...args) {
        // eslint-disable-next-line no-console
        console.error(...args);
    },
};

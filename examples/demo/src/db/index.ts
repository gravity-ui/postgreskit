import * as path from 'path';

import {initDB} from '@gravity-ui/postgreskit';

import {nodekit} from '../nodekit';

const knexOptions = {
    client: 'pg',
    pool: {
        min: 0,
        max: 15,
        acquireTimeoutMillis: 40000,
        createTimeoutMillis: 50000,
        idleTimeoutMillis: 45000,
        reapIntervalMillis: 1000,
    },
    acquireConnectionTimeout: 10000,
    migrations: {
        directory: path.resolve(__dirname, 'migrations'),
        tableName: 'migrations',
        extension: 'js',
        loadExtensions: ['.js'],
    },
    seeds: {
        directory: path.resolve(__dirname, 'seeds'),
        loadExtensions: ['.js'],
    },
    debug: true,
};

const dispatcherOptions = {
    healthcheckInterval: 5000,
    healthcheckTimeout: 2000,
    suppressStatusLogs: true,
};

const {db, CoreBaseModel, helpers} = initDB({
    connectionString: 'postgresql://test_user:test_user@localhost:5432/test_postgreskit',
    dispatcherOptions,
    knexOptions,
    logger: {
        info: (...args) => nodekit.ctx.log(...args),
        error: (...args) => nodekit.ctx.logError(...args),
    },
});

class Model extends CoreBaseModel {
    static DEFAULT_QUERY_TIMEOUT = 20000;
}

export {db, Model, helpers};

import * as path from 'path';

import {initDB} from '@gravity-ui/postgreskit';
import {getTestDsnList, testDbConfig} from '../tests/constants';

import {nodekit} from '../nodekit';

export const knexOptions = {
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
    debug: false,
};

const dispatcherOptions = {
    healthcheckInterval: 5000,
    healthcheckTimeout: 2000,
    suppressStatusLogs: true,
};

const connectionString =
    process.env.APP_ENV === 'test'
        ? getTestDsnList()
        : `postgresql://${testDbConfig.user}:${testDbConfig.password}@localhost:5432/${testDbConfig.dbName}`;

const {db, CoreBaseModel, helpers} = initDB({
    connectionString,
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

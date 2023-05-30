import type {Knex} from 'knex';
import _ from 'lodash';
import {Model} from 'objection';

import {defaultDispatcherOptions, defaultExLogger, defaultKnexOptions} from './constants';
import {PGDispatcher} from './dispatcher';
import type {ExLogger} from './types';

export interface CoreDBDispatcherOptions {
    healthcheckInterval?: number;
    healthcheckTimeout?: number;
    suppressStatusLogs?: boolean;
    beforeTerminate?: () => Promise<void>;
}
export interface CoreDBConstructorArgs {
    connectionString: string;
    dispatcherOptions?: CoreDBDispatcherOptions;
    knexOptions?: Knex.Config;
    logger?: ExLogger;
}

class CoreBaseModel extends Model {
    private static _db: PGDispatcher;

    static set db(value: PGDispatcher) {
        if (!CoreBaseModel._db) {
            CoreBaseModel._db = value;
        }
    }

    static get primary() {
        return CoreBaseModel._db.primary;
    }

    get primary() {
        return CoreBaseModel._db.primary;
    }

    static get replica() {
        return CoreBaseModel._db.replica;
    }

    get replica() {
        return CoreBaseModel._db.replica;
    }
}

export function initDB({
    connectionString,
    dispatcherOptions,
    knexOptions = {},
    logger = defaultExLogger,
}: CoreDBConstructorArgs) {
    if (!connectionString) {
        throw new Error('Empty connection string');
    }
    const mergedKnexOptions = _.merge(defaultKnexOptions, knexOptions);
    const mergedDispatcherOptions = _.merge(defaultDispatcherOptions, dispatcherOptions);

    const db = new PGDispatcher({
        connections: connectionString.split(','),
        options: mergedDispatcherOptions,
        knexOptions: mergedKnexOptions,
        logger,
    });

    const terminate = () => {
        const beforeTerminate = mergedDispatcherOptions.beforeTerminate;

        beforeTerminate()
            .catch(() => {})
            .then(() => db.terminate())
            .then(() => process.exit(0))
            .catch((error: unknown) => {
                console.error(error);
                process.exit(-1);
            });
    };

    process.on('SIGINT', terminate);
    process.on('SIGUSR1', terminate);
    process.on('SIGUSR2', terminate);

    CoreBaseModel.db = db;

    const helpers = {
        clearDatabase: async function () {
            await db.ready();
            await db.primary.migrate.rollback({}, true);
        },
        rollbackDatabase: async function () {
            await db.ready();
            await db.primary.migrate.rollback({});
        },
        migrateDatabase: async function () {
            await db.ready();
            await db.primary.migrate.latest();
        },
        prepareDatabase: async function () {
            await db.primary.migrate.latest();
            await db.primary.seed.run();
        },
    };
    logger.log('Core-db is up and running!');
    return {db, CoreBaseModel, helpers};
}

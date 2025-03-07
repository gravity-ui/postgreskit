import type {Knex} from 'knex';
import _ from 'lodash';
import {Model} from 'objection';

import {defaultDispatcherOptions, defaultExLogger, defaultKnexOptions} from './constants';
import {PGDispatcher} from './dispatcher';
import type {BaseModel, ExLogger} from './types';

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

export function getModel(): typeof BaseModel {
    let _db: PGDispatcher;

    class CoreBaseModel extends Model {
        static set db(value: PGDispatcher) {
            if (!_db) {
                _db = value;
            }
        }

        static get primary() {
            return _db.primary;
        }

        get primary() {
            return _db.primary;
        }

        static get replica() {
            return _db.replica;
        }

        get replica() {
            return _db.replica;
        }
    }

    return CoreBaseModel;
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
    const mergedKnexOptions = _.merge({}, defaultKnexOptions, knexOptions);
    const mergedDispatcherOptions = _.merge({}, defaultDispatcherOptions, dispatcherOptions);

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
            .catch((error: unknown) => {
                // eslint-disable-next-line no-console
                console.error(error);
            });
    };

    process.on('SIGINT', terminate);

    const CoreBaseModel = getModel();
    CoreBaseModel.db = db;

    const helpers = {
        clearDatabase: async function () {
            await db.ready();
            await db.primary.migrate.rollback({}, true);
        },
        rollbackDatabase: async function (args?: {onlyOne: boolean}) {
            await db.ready();

            const onlyOne = args ? args.onlyOne : false;

            if (onlyOne) {
                await db.primary.migrate.down();
            } else {
                await db.primary.migrate.rollback({});
            }
        },
        migrateDatabase: async function (args?: {onlyOne: boolean}) {
            await db.ready();

            const onlyOne = args ? args.onlyOne : false;
            if (onlyOne) {
                await db.primary.migrate.up();
            } else {
                await db.primary.migrate.latest();
            }
        },
        prepareDatabase: async function () {
            await db.primary.migrate.latest();
            await db.primary.seed.run();
        },
    };
    logger.info('Core-db is up and running!');
    return {db, terminate, CoreBaseModel, helpers};
}

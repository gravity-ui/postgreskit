import {URL} from 'url';

import knexBuilder from 'knex';
import type {Knex} from 'knex';

import type {Dict, ExLogger, PDOptions} from './types';

import Timeout = NodeJS.Timer;

interface InfoLogger {
    (input: {message: string; data?: Dict}): void;
}

interface ErrorLogger {
    (
        input:
            | {message: string; error?: Error; data?: Dict}
            | {message?: string; error: Error; data?: Dict},
    ): void;
}

export interface PDConstructorArgs {
    connections: string[];
    options: PDOptions;
    knexOptions?: Knex.Config;
    logger: ExLogger;
}

interface PDConnection {
    host: string;
    knex: Knex;
    primary: boolean;
    healthy: boolean;
    latency: number;
}

interface PDCheckupResult {
    pingOk: boolean;
    primary: boolean;
}

export class PDError extends Error {
    code?: string;
}

export class PGDispatcher {
    knexOptions: Knex.Config;

    private connections: PDConnection[];
    private options: PDOptions;
    private logger: {info: InfoLogger; error: ErrorLogger};
    private hcTimer?: Timeout | null;
    private isInit = false;

    constructor({connections = [], options, knexOptions = {}, logger}: PDConstructorArgs) {
        if (!connections.length) {
            throw new Error('Empty connections list is not allowed');
        }

        this.connections = connections.map((connectionString) => {
            const url = new URL(connectionString);
            return {
                host: url.hostname,
                knex: knexBuilder({
                    ...knexOptions,
                    client: 'pg',
                    connection: connectionString,
                }),
                primary: false,
                healthy: false,
                latency: Infinity,
            };
        });
        this.options = options;
        this.knexOptions = knexOptions;

        this.logger = {
            info: ({message, data}) => {
                if (!this.options.suppressStatusLogs) {
                    logger.info(message, data);
                }
            },
            error: ({message, error, data}) => {
                if (!this.options.suppressStatusLogs) {
                    const messageToReport = message || 'Error without description';
                    const errorToReport = error || new Error(messageToReport);
                    logger.error('PGDispatcher error', errorToReport, data);
                }
            },
        };

        this.initHealthcheck().catch((error) => {
            this.logger.error({error});
        });
    }

    get knexConfig() {
        return this.knexOptions;
    }

    async ready() {
        if (!this.isInit) {
            await this.knexReady();
            await Promise.all(this.connections.map((c) => this.checkDatabase(c)));

            this.isInit = true;
        }

        return Promise.resolve();
    }

    terminate() {
        if (this.hcTimer) {
            clearInterval(this.hcTimer);
        }

        return Promise.all(
            this.connections.map((c) =>
                c.knex
                    .destroy()
                    .then(() => {
                        this.logger.info({
                            message: 'Connection successfully terminated',
                            data: {host: c.host},
                        });
                    })
                    .catch((error) =>
                        this.logger.error({
                            message: 'Error during connection terminating',
                            error,
                            data: {host: c.host},
                        }),
                    ),
            ),
        );
    }

    get primary() {
        this.checkConnectionsAvailability();

        const primaryConnections = this.connections.filter((c) => c.primary);
        if (primaryConnections.length > 1) {
            this.logger.error({
                message: 'Multiple primary connections detected, something is wrong',
                data: {
                    primaryConnections: primaryConnections.map((c) => c.host),
                },
            });
        }

        const primaryConnection = primaryConnections[0];
        if (!primaryConnection) {
            const error = new PDError('No primary connection available');
            error.code = 'ERR_DB_READ_ONLY';
            throw error;
        }
        return primaryConnection.knex;
    }

    get replica() {
        this.checkConnectionsAvailability();

        const replicaConnections = this.healthyConnections.filter((c) => !c.primary);

        if (replicaConnections.length) {
            const fastestReplica = replicaConnections.sort((a, b) => a.latency - b.latency)[0];
            return fastestReplica.knex;
        }
        if (this.connections.length > 1) {
            this.logger.error({message: 'No alive replica available, using master for read'});
        }

        if (this.healthyConnections.length) {
            return this.healthyConnections[0].knex;
        } else {
            const error = new PDError('No connections available');
            error.code = 'ERR_DB_UNAVAILABLE';
            throw error;
        }
    }

    private async initHealthcheck() {
        await this.knexReady();

        const performHealthcheck = () => {
            const checkups = this.connections.map((connection) =>
                this.checkDatabase(connection).catch((error) => {
                    this.logger.error({message: 'Unhandled error during database checkup', error});
                    connection.healthy = false;
                    connection.primary = false;
                }),
            );
            Promise.all(checkups).then(() => {
                this.logger.info({
                    message: 'Database current status',
                    data: {
                        connections: this.connections.map((c) => ({
                            host: c.host,
                            primary: c.primary,
                            healthy: c.healthy,
                            latency: c.latency,
                        })),
                    },
                });
            });
        };

        performHealthcheck();

        this.hcTimer = setInterval(() => {
            performHealthcheck();
        }, this.options.healthcheckInterval);
    }

    private async performCheckupQuery(knex: Knex): Promise<PDCheckupResult> {
        const result = await knex
            .raw('SELECT pg_is_in_recovery();')
            .timeout(this.options.healthcheckTimeout);

        const isReplica =
            result && result.rows && result.rows[0] && result.rows[0].pg_is_in_recovery;

        const pingOk = typeof isReplica === 'boolean';
        const isPrimary = pingOk && isReplica === false;

        return {pingOk, primary: isPrimary};
    }

    private async checkDatabase(connection: PDConnection) {
        try {
            const startTime = new Date().getTime();
            type RaceCheckupResult = PDCheckupResult | null;
            const checkupResult: RaceCheckupResult = (await Promise.race([
                Promise.resolve(this.performCheckupQuery(connection.knex)).catch((error) => {
                    this.logger.error({message: 'Error performing database checkup', error});
                }),
                new Promise((resolve) => {
                    setTimeout(() => resolve(null), this.options.healthcheckTimeout + 10);
                }),
            ])) as RaceCheckupResult;
            connection.latency = new Date().getTime() - startTime;

            if (checkupResult) {
                connection.healthy = checkupResult.pingOk;
                connection.primary = checkupResult.primary;
            } else {
                if (connection.latency > this.options.healthcheckTimeout) {
                    this.logger.error({
                        message: 'Database checkup timeouted',
                        data: {host: connection.host},
                    });
                } else {
                    this.logger.error({
                        message: 'Database checkup failed',
                        data: {host: connection.host},
                    });
                }

                connection.healthy = false;
                connection.primary = false;
            }
        } catch (error) {
            connection.healthy = false;
            connection.primary = false;
            this.logger.error({
                message: 'Database checkup failed',
                error: error as Error,
                data: {host: connection.host},
            });
        }
    }

    private async knexReady() {
        await Promise.all(this.connections.map((c) => c.knex));
    }

    private get healthyConnections() {
        return this.connections.filter((c) => c.healthy);
    }

    private checkConnectionsAvailability() {
        if (!this.healthyConnections.length) {
            const error = new PDError('No connections available');
            error.code = 'ERR_DB_NOT_AVAILABLE';
            throw error;
        }
    }
}

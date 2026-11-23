import {URL} from 'url';

import knexBuilder from 'knex';
import type {Knex} from 'knex';
import {Pool, type PoolClient} from 'pg';

import type {
    BalancingStrategy,
    Dict,
    ExLogger,
    PDOptions,
    PGConnectionRole,
    PGHealthcheckHandler,
    PGHealthcheckStatus,
} from './types';

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

    onKnexCreated?: (knex: Knex) => void;
    onHealthcheck?: PGHealthcheckHandler;
}

interface PDConnection {
    host: string;
    knex: Knex;
    healthcheckPool: Pool;
    check?: Promise<void>;
    cancelCheck?: () => void;
    primary: boolean;
    healthy: boolean;
    latency: number;
}

interface PDCheckupResult {
    pingOk: boolean;
    primary: boolean;
}

// returns the first connection with the lowest latency, so ties go to the earliest one
function fastestConnection(candidates: PDConnection[]) {
    let fastest = candidates[0];

    for (const candidate of candidates) {
        if (candidate.latency < fastest.latency) {
            fastest = candidate;
        }
    }

    return fastest;
}

function validateBalancingStrategy(strategy?: BalancingStrategy): BalancingStrategy {
    if (strategy?.kind !== 'round-robin') {
        return {kind: 'fastest'};
    }

    const {latencyToleranceMs} = strategy;

    if (
        latencyToleranceMs !== undefined &&
        (!Number.isFinite(latencyToleranceMs) || latencyToleranceMs < 0)
    ) {
        throw new Error(
            `balancingStrategy.latencyToleranceMs must be a non-negative finite number, got ${String(
                latencyToleranceMs,
            )}`,
        );
    }

    return {kind: 'round-robin', latencyToleranceMs};
}

export class PDError extends Error {
    code?: string;
}

export class PGDispatcher {
    knexOptions: Knex.Config;

    private connections: PDConnection[];
    private options: PDOptions;
    private logger: {info: InfoLogger; error: ErrorLogger};
    private onHealthcheck?: PGHealthcheckHandler;
    private hcTimer?: Timeout | null;
    private initialHealthcheck: Promise<void>;
    private healthcheck?: Promise<void>;
    private termination?: Promise<void[]>;
    private isTerminating = false;
    private readonly balancingStrategy: BalancingStrategy;
    private balancingCursor = 0;

    constructor({
        connections = [],
        options,
        knexOptions = {},
        logger,
        onKnexCreated,
        onHealthcheck,
    }: PDConstructorArgs) {
        if (!connections.length) {
            throw new Error('Empty connections list is not allowed');
        }

        this.balancingStrategy = validateBalancingStrategy(options.balancingStrategy);

        this.connections = connections.map((connectionString) => {
            const url = new URL(connectionString);
            const knex = knexBuilder({
                ...knexOptions,
                client: 'pg',
                connection: connectionString,
            });
            onKnexCreated?.(knex);
            const healthcheckPool = new Pool({
                connectionString,
                min: 0,
                max: 1,
                connectionTimeoutMillis: options.healthcheckTimeout,
            });
            healthcheckPool.on('error', (error) => {
                this.logger.error({error, data: {host: url.hostname, phase: 'idle'}});
            });
            return {
                host: url.hostname,
                knex,
                healthcheckPool,
                primary: false,
                healthy: false,
                latency: Infinity,
            };
        });
        this.options = options;
        this.knexOptions = knexOptions;
        this.onHealthcheck = onHealthcheck;

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

        this.initialHealthcheck = this.performHealthcheck();
        this.hcTimer = setInterval(() => {
            this.performHealthcheck();
        }, this.options.healthcheckInterval);
    }

    get knexConfig() {
        return this.knexOptions;
    }

    async ready() {
        await this.initialHealthcheck;
    }

    terminate() {
        if (this.termination) {
            return this.termination;
        }
        this.isTerminating = true;

        if (this.hcTimer) {
            clearInterval(this.hcTimer);
            this.hcTimer = null;
        }
        this.connections.forEach((connection) => connection.cancelCheck?.());
        this.termination = Promise.all(
            this.connections.flatMap((c) =>
                [c.knex.destroy(), c.healthcheckPool.end()].map((closing) =>
                    closing
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
            ),
        );
        return this.termination;
    }

    get primary() {
        this.checkConnectionsAvailability();

        if (this.isProxyMode) {
            return this.selectConnection(this.healthyConnections).knex;
        }

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

        if (this.isProxyMode) {
            return this.selectConnection(this.healthyConnections).knex;
        }

        const replicaConnections = this.healthyConnections.filter((c) => !c.primary);

        if (replicaConnections.length) {
            return this.selectConnection(replicaConnections).knex;
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

    private performHealthcheck(): Promise<void> {
        if (this.isTerminating) {
            return Promise.resolve();
        }
        if (this.healthcheck) {
            return this.healthcheck;
        }
        this.healthcheck = Promise.all(this.connections.map((c) => this.checkDatabase(c)))
            .then(() => {
                if (this.isTerminating) {
                    return;
                }
                const status = this.getHealthcheckStatus();
                if (!this.options.suppressHealthcheckStatusLogs) {
                    this.logger.info({
                        message: 'Database current status',
                        data: {
                            ...(this.isProxyMode ? {topologyMode: this.options.topologyMode} : {}),
                            connections: this.connections.map((connection) => ({
                                host: connection.host,
                                ...(this.isProxyMode ? {} : {primary: connection.primary}),
                                healthy: connection.healthy,
                                latency: connection.latency,
                            })),
                        },
                    });
                }
                this.notifyHealthcheck(status);
            })
            .finally(() => {
                this.healthcheck = undefined;
            });
        return this.healthcheck;
    }

    private async performCheckupQuery(client: PoolClient): Promise<PDCheckupResult> {
        if (this.isProxyMode) {
            await client.query('SELECT 1;');

            return {pingOk: true, primary: false};
        }

        const result = await client.query('SELECT pg_is_in_recovery();');

        const isReplica =
            result && result.rows && result.rows[0] && result.rows[0].pg_is_in_recovery;

        const pingOk = typeof isReplica === 'boolean';
        const isPrimary = pingOk && isReplica === false;

        return {pingOk, primary: isPrimary};
    }

    private checkDatabase(connection: PDConnection): Promise<void> {
        if (connection.check) {
            return connection.check;
        }
        const startTime = Date.now();
        let phase = 'acquire';
        let expired = false;
        let client: PoolClient | undefined;
        let released = false;
        const release = (destroy = false) => {
            if (client && !released) {
                released = true;
                client.release(destroy);
                client.removeListener('error', onClientError);
            }
        };
        let rejectDeadline: (error: Error) => void;
        const deadlineResult = new Promise<never>((_, reject) => {
            rejectDeadline = reject;
        });
        function onClientError(error: Error) {
            expired = true;
            release(true);
            rejectDeadline(error);
        }
        const cancel = () => {
            expired = true;
            // Destroy an in-flight query's socket; never return it to the idle pool.
            release(true);
            rejectDeadline(new Error('Database checkup timeouted'));
        };
        const deadline = setTimeout(cancel, this.options.healthcheckTimeout);
        connection.cancelCheck = cancel;
        const physicalCheck = (async () => {
            try {
                client = await connection.healthcheckPool.connect();
                client.on('error', onClientError);
                if (expired) {
                    release(true);
                    throw new Error('Database checkup timeouted');
                }
                phase = 'query';
                return await this.performCheckupQuery(client);
            } catch (error) {
                // Driver-side query timeouts may reject before the server stops executing.
                release(true);
                throw error;
            } finally {
                release();
            }
        })();
        const result = Promise.race([physicalCheck, deadlineResult])
            .then((checkup) => {
                if (!this.isTerminating) {
                    connection.healthy = checkup.pingOk;
                    connection.primary = checkup.primary;
                }
            })
            .catch((error) => {
                if (!this.isTerminating) {
                    connection.healthy = false;
                    connection.primary = false;
                    this.logger.error({
                        message: 'Error performing database checkup',
                        error,
                        data: {host: connection.host, phase},
                    });
                }
            })
            .finally(() => {
                clearTimeout(deadline);
                connection.cancelCheck = undefined;
                connection.latency = Date.now() - startTime;
            });
        connection.check = result;
        // The deadline reports failure immediately. Keep single-flight protection until
        // the physical operation settles so late completion cannot overlap a new probe.
        physicalCheck
            .catch(() => {})
            .finally(() => {
                result.then(() => {
                    connection.check = undefined;
                });
            });
        return result;
    }

    private getHealthcheckStatus(): PGHealthcheckStatus {
        if (this.isProxyMode) {
            return {
                topologyMode: 'proxy',
                connections: this.connections.map((connection) => ({
                    host: connection.host,
                    healthy: connection.healthy,
                    latency: connection.latency,
                })),
            };
        }

        return {
            topologyMode: 'primary-replica',
            connections: this.connections.map((connection) => ({
                host: connection.host,
                role: this.getConnectionRole(connection),
                healthy: connection.healthy,
                latency: connection.latency,
            })),
        };
    }

    private getConnectionRole(connection: PDConnection): PGConnectionRole {
        if (!connection.healthy) {
            return 'unknown';
        }

        return connection.primary ? 'primary' : 'replica';
    }

    private notifyHealthcheck(status: PGHealthcheckStatus) {
        if (!this.onHealthcheck || this.isTerminating) {
            return;
        }

        try {
            this.onHealthcheck(status);
        } catch (error) {
            this.reportHealthcheckCallbackError(error);
        }
    }

    private reportHealthcheckCallbackError(error: unknown) {
        this.logger.error({
            message: 'Database healthcheck callback failed',
            error: error as Error,
        });
    }

    private get healthyConnections() {
        return this.connections.filter((c) => c.healthy);
    }

    private get isProxyMode() {
        return this.options.topologyMode === 'proxy';
    }

    // `candidates` must be non-empty.
    private selectConnection(candidates: PDConnection[]) {
        const strategy = this.balancingStrategy;

        if (strategy.kind === 'round-robin') {
            return this.selectRoundRobin(candidates, strategy.latencyToleranceMs);
        }

        return fastestConnection(candidates);
    }

    // Rotates between all connections or, when `latencyToleranceMs` is set, only those whose
    // latest health-check latency is within `latencyToleranceMs` of the fastest one.
    private selectRoundRobin(candidates: PDConnection[], latencyToleranceMs?: number) {
        let eligible = candidates;

        if (latencyToleranceMs !== undefined) {
            const minLatency = fastestConnection(candidates).latency;
            eligible = candidates.filter((c) => c.latency <= minLatency + latencyToleranceMs);
        }

        // the window may shrink between health checks, so wrap the stored position into it
        const index = this.balancingCursor % eligible.length;
        this.balancingCursor = index + 1;

        return eligible[index];
    }

    private checkConnectionsAvailability() {
        if (!this.healthyConnections.length) {
            const error = new PDError('No connections available');
            error.code = 'ERR_DB_NOT_AVAILABLE';
            throw error;
        }
    }
}

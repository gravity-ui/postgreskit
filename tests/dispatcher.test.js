/* eslint-env jest */

jest.mock('knex', () => jest.fn());

const knexBuilder = require('knex');

const {defaultDispatcherOptions} = require('../build/constants');
const {initDB} = require('../build/core');
const {PGDispatcher} = require('../build/dispatcher');

const activeDispatchers = [];

function createKnex(checkup) {
    const timeout = jest.fn(() => checkup());

    return {
        destroy: jest.fn(() => Promise.resolve()),
        raw: jest.fn(() => ({timeout})),
        timeout,
    };
}

function successfulCheckup(row, latency = 0) {
    return () =>
        new Promise((resolve) => {
            setTimeout(() => resolve({rows: [row]}), latency);
        });
}

function failedCheckup() {
    return Promise.reject(new Error('Proxy unavailable'));
}

function createDispatcher(clients, options = {}, onHealthcheck) {
    clients.forEach((client) => knexBuilder.mockImplementationOnce(() => client));

    const logger = {
        error: jest.fn(),
        info: jest.fn(),
    };
    const dispatcher = new PGDispatcher({
        connections: clients.map(
            (_, index) => `postgresql://user:password@database-${index}.example/db`,
        ),
        logger,
        options: {
            ...defaultDispatcherOptions,
            healthcheckInterval: 60_000,
            healthcheckTimeout: 100,
            ...options,
        },
        onHealthcheck,
    });

    activeDispatchers.push(dispatcher);

    return {dispatcher, logger};
}

function loggedErrorMessages(logger) {
    return logger.error.mock.calls.map(([, error]) => error.message);
}

afterEach(async () => {
    await Promise.all(activeDispatchers.splice(0).map((dispatcher) => dispatcher.terminate()));
});

describe('PGDispatcher topology modes', () => {
    test('the default mode keeps the primary/replica health check and routing behavior', async () => {
        const primary = createKnex(successfulCheckup({pg_is_in_recovery: false}));
        const replica = createKnex(successfulCheckup({pg_is_in_recovery: true}));
        const {dispatcher} = createDispatcher([primary, replica]);

        await dispatcher.ready();

        expect(defaultDispatcherOptions.topologyMode).toBe('primary-replica');
        expect(primary.raw).toHaveBeenCalledWith('SELECT pg_is_in_recovery();');
        expect(replica.raw).toHaveBeenCalledWith('SELECT pg_is_in_recovery();');
        expect(dispatcher.primary).toBe(primary);
        expect(dispatcher.replica).toBe(replica);
    });

    test('the default mode emits primary/replica topology warnings', async () => {
        const firstPrimary = createKnex(successfulCheckup({pg_is_in_recovery: false}));
        const secondPrimary = createKnex(successfulCheckup({pg_is_in_recovery: false}));
        const {dispatcher, logger} = createDispatcher([firstPrimary, secondPrimary]);

        await dispatcher.ready();

        expect(dispatcher.primary).toBe(firstPrimary);
        expect(dispatcher.replica).toBe(firstPrimary);

        const errorMessages = loggedErrorMessages(logger);
        expect(errorMessages).toContain(
            'Multiple primary connections detected, something is wrong',
        );
        expect(errorMessages).toContain('No alive replica available, using master for read');
    });

    test('proxy mode routes both roles to the fastest healthy endpoint without topology warnings', async () => {
        const slowerProxy = createKnex(successfulCheckup({value: 1}, 30));
        const fasterProxy = createKnex(successfulCheckup({value: 1}, 5));
        const unhealthyProxy = createKnex(failedCheckup);
        const {dispatcher, logger} = createDispatcher([slowerProxy, fasterProxy, unhealthyProxy], {
            topologyMode: 'proxy',
        });

        await dispatcher.ready();

        for (const proxy of [slowerProxy, fasterProxy, unhealthyProxy]) {
            expect(proxy.raw).toHaveBeenCalledWith('SELECT 1;');
            expect(proxy.raw).not.toHaveBeenCalledWith('SELECT pg_is_in_recovery();');
        }
        expect(dispatcher.primary).toBe(fasterProxy);
        expect(dispatcher.replica).toBe(fasterProxy);

        const statusLog = logger.info.mock.calls.find(
            ([message]) => message === 'Database current status',
        );
        expect(statusLog[1].topologyMode).toBe('proxy');
        for (const connection of statusLog[1].connections) {
            expect(connection).not.toHaveProperty('primary');
        }

        const errorMessages = loggedErrorMessages(logger);
        expect(errorMessages).not.toContain(
            'Multiple primary connections detected, something is wrong',
        );
        expect(errorMessages).not.toContain('No alive replica available, using master for read');
    });

    test('the existing unavailable-database error is preserved when all proxies are unhealthy', async () => {
        const {dispatcher} = createDispatcher(
            [createKnex(failedCheckup), createKnex(failedCheckup)],
            {topologyMode: 'proxy'},
        );

        await dispatcher.ready();

        for (const connection of ['primary', 'replica']) {
            expect(() => dispatcher[connection]).toThrow(
                expect.objectContaining({
                    code: 'ERR_DB_NOT_AVAILABLE',
                    message: 'No connections available',
                }),
            );
        }
    });
});

describe('PGDispatcher healthcheck status logging', () => {
    test('logs database status by default', async () => {
        const {dispatcher, logger} = createDispatcher([
            createKnex(successfulCheckup({pg_is_in_recovery: false})),
        ]);

        await dispatcher.ready();
        await new Promise((resolve) => setImmediate(resolve));

        expect(defaultDispatcherOptions.suppressHealthcheckStatusLogs).toBe(false);
        expect(logger.info).toHaveBeenCalledWith(
            'Database current status',
            expect.objectContaining({connections: expect.any(Array)}),
        );
    });

    test('suppresses database status while preserving healthcheck errors', async () => {
        const {dispatcher, logger} = createDispatcher([createKnex(failedCheckup)], {
            suppressHealthcheckStatusLogs: true,
        });

        await dispatcher.ready();
        await new Promise((resolve) => setImmediate(resolve));

        expect(logger.info).not.toHaveBeenCalled();
        expect(loggedErrorMessages(logger)).toContain('Proxy unavailable');
    });
});

describe('PGDispatcher healthcheck callback', () => {
    test('reports a snapshot for every primary and replica connection', async () => {
        const onHealthcheck = jest.fn();
        const primary = createKnex(successfulCheckup({pg_is_in_recovery: false}));
        const replica = createKnex(successfulCheckup({pg_is_in_recovery: true}));
        const unavailable = createKnex(failedCheckup);
        const {dispatcher, logger} = createDispatcher(
            [primary, replica, unavailable],
            {},
            onHealthcheck,
        );

        await dispatcher.ready();
        await new Promise((resolve) => setImmediate(resolve));

        expect(onHealthcheck).toHaveBeenCalledWith({
            topologyMode: 'primary-replica',
            connections: [
                {
                    host: 'database-0.example',
                    role: 'primary',
                    healthy: true,
                    latency: expect.any(Number),
                },
                {
                    host: 'database-1.example',
                    role: 'replica',
                    healthy: true,
                    latency: expect.any(Number),
                },
                {
                    host: 'database-2.example',
                    role: 'unknown',
                    healthy: false,
                    latency: expect.any(Number),
                },
            ],
        });

        const statusLog = logger.info.mock.calls.find(
            ([message]) => message === 'Database current status',
        );
        expect(statusLog[1].connections).toEqual([
            expect.objectContaining({host: 'database-0.example', primary: true}),
            expect.objectContaining({host: 'database-1.example', primary: false}),
            expect.objectContaining({host: 'database-2.example', primary: false}),
        ]);
    });

    test('reports proxy status without primary/replica roles when status logs are suppressed', async () => {
        const onHealthcheck = jest.fn();
        const {dispatcher, logger} = createDispatcher(
            [createKnex(successfulCheckup({value: 1}))],
            {suppressStatusLogs: true, topologyMode: 'proxy'},
            onHealthcheck,
        );

        await dispatcher.ready();
        await new Promise((resolve) => setImmediate(resolve));

        expect(logger.info).not.toHaveBeenCalled();
        expect(onHealthcheck).toHaveBeenCalledWith({
            topologyMode: 'proxy',
            connections: [
                {
                    host: 'database-0.example',
                    healthy: true,
                    latency: expect.any(Number),
                },
            ],
        });
        expect(onHealthcheck.mock.calls[0][0].connections[0]).not.toHaveProperty('role');
    });

    test('isolates callback errors from database routing', async () => {
        const callbackError = new Error('Healthcheck consumer failed');
        const onHealthcheck = jest.fn(() => {
            throw callbackError;
        });
        const primary = createKnex(successfulCheckup({pg_is_in_recovery: false}));
        const {dispatcher, logger} = createDispatcher([primary], {}, onHealthcheck);

        await dispatcher.ready();
        await new Promise((resolve) => setImmediate(resolve));

        expect(dispatcher.primary).toBe(primary);
        expect(logger.error).toHaveBeenCalledWith('PGDispatcher error', callbackError, undefined);
    });

    test('does not notify after termination starts', async () => {
        let finishCheckup;
        const checkup = () =>
            new Promise((resolve) => {
                finishCheckup = resolve;
            });
        const onHealthcheck = jest.fn();
        const {dispatcher} = createDispatcher([createKnex(checkup)], {}, onHealthcheck);

        await new Promise((resolve) => setImmediate(resolve));
        await dispatcher.terminate();
        finishCheckup({rows: [{pg_is_in_recovery: false}]});
        await new Promise((resolve) => setImmediate(resolve));

        expect(onHealthcheck).not.toHaveBeenCalled();
    });
});

describe('PGDispatcher healthcheck timer cleanup', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test.each(['success', 'failure'])(
        'clears healthcheck deadlines after query %s and termination',
        async (result) => {
            const checkup =
                result === 'success'
                    ? () => Promise.resolve({rows: [{pg_is_in_recovery: false}]})
                    : failedCheckup;
            const {dispatcher} = createDispatcher([createKnex(checkup)]);

            await dispatcher.ready();
            await dispatcher.terminate();

            expect(jest.getTimerCount()).toBe(0);
        },
    );

    test('retains the deadline for a healthcheck that never completes', async () => {
        const {dispatcher} = createDispatcher([createKnex(() => new Promise(() => {}))]);
        const ready = dispatcher.ready();

        await jest.advanceTimersByTimeAsync(110);
        await ready;

        expect(() => dispatcher.primary).toThrow(
            expect.objectContaining({code: 'ERR_DB_NOT_AVAILABLE'}),
        );
        await dispatcher.terminate();
        expect(jest.getTimerCount()).toBe(0);
    });
});

describe('PGDispatcher balancing strategies', () => {
    function pick(dispatcher, role, times) {
        return Array.from({length: times}, () => dispatcher[role]);
    }

    // health-check latencies are measured with real timers; pin them to avoid jitter
    function setLatencies(dispatcher, latencies) {
        dispatcher.connections.forEach((connection, index) => {
            connection.latency = latencies[index];
        });
    }

    function createReplicaSet(replicaCount, options) {
        const primary = createKnex(successfulCheckup({pg_is_in_recovery: false}));
        const replicas = Array.from({length: replicaCount}, () =>
            createKnex(successfulCheckup({pg_is_in_recovery: true})),
        );
        const {dispatcher} = createDispatcher([primary, ...replicas], options);

        return {dispatcher, primary, replicas};
    }

    test('routes to the fastest replica when no balancing strategy is provided', async () => {
        const {dispatcher, primary, replicas} = createReplicaSet(3);

        await dispatcher.ready();
        setLatencies(dispatcher, [1, 3, 1, 2]);

        expect(new Set(pick(dispatcher, 'replica', 4))).toEqual(new Set([replicas[1]]));
        expect(dispatcher.primary).toBe(primary);
    });

    test('fastest does not rotate equally fast replicas', async () => {
        const {dispatcher, replicas} = createReplicaSet(3, {balancingStrategy: {kind: 'fastest'}});

        await dispatcher.ready();
        setLatencies(dispatcher, [1, 1, 1, 2]);

        expect(new Set(pick(dispatcher, 'replica', 4))).toEqual(new Set([replicas[0]]));
    });

    test.each([-1, NaN, Infinity, null, '10'])(
        'rejects an invalid latencyToleranceMs: %p',
        (latencyToleranceMs) => {
            // validation runs before any knex instance is created, so no knex mocks are queued
            expect(
                () =>
                    new PGDispatcher({
                        connections: ['postgresql://user:password@database-0.example/db'],
                        logger: {info: jest.fn(), error: jest.fn()},
                        options: {
                            ...defaultDispatcherOptions,
                            balancingStrategy: {kind: 'round-robin', latencyToleranceMs},
                        },
                    }),
            ).toThrow('balancingStrategy.latencyToleranceMs must be a non-negative finite number');
        },
    );

    test('uses the validated strategy after the original options are changed', async () => {
        const balancingStrategy = {kind: 'round-robin', latencyToleranceMs: 10};
        const {dispatcher, replicas} = createReplicaSet(2, {balancingStrategy});

        await dispatcher.ready();
        setLatencies(dispatcher, [1, 1, 2]);
        balancingStrategy.latencyToleranceMs = -1;

        expect(pick(dispatcher, 'replica', 2)).toEqual(replicas);
    });

    test('initDB uses the configured strategy to select proxies', async () => {
        const proxies = [
            createKnex(successfulCheckup({value: 1})),
            createKnex(successfulCheckup({value: 1})),
        ];
        proxies.forEach((proxy) => knexBuilder.mockImplementationOnce(() => proxy));

        const {db, terminate} = initDB({
            connectionString: 'postgresql://db-0.example/db,postgresql://db-1.example/db',
            dispatcherOptions: {
                topologyMode: 'proxy',
                healthcheckInterval: 60_000,
                balancingStrategy: {kind: 'round-robin'},
            },
            logger: {info: jest.fn(), error: jest.fn()},
        });
        activeDispatchers.push(db);

        try {
            await db.ready();
            setLatencies(db, [1, 2]);

            expect(pick(db, 'primary', 2)).toEqual(proxies);
        } finally {
            process.removeListener('SIGINT', terminate);
        }
    });

    test('round-robin with a zero window rotates only equally fast replicas', async () => {
        const {dispatcher, replicas} = createReplicaSet(3, {
            balancingStrategy: {kind: 'round-robin', latencyToleranceMs: 0},
        });

        await dispatcher.ready();
        setLatencies(dispatcher, [1, 1, 1, 2]);

        expect(pick(dispatcher, 'replica', 4)).toEqual([
            replicas[0],
            replicas[1],
            replicas[0],
            replicas[1],
        ]);
    });

    test('rotates replicas whose latency is within the tolerance window', async () => {
        const {dispatcher, replicas} = createReplicaSet(3, {
            balancingStrategy: {kind: 'round-robin', latencyToleranceMs: 10},
        });

        await dispatcher.ready();
        setLatencies(dispatcher, [1, 2, 12, 13]);

        expect(pick(dispatcher, 'replica', 4)).toEqual([
            replicas[0],
            replicas[1],
            replicas[0],
            replicas[1],
        ]);
    });

    test('round-robin without a window uses every healthy replica regardless of latency', async () => {
        const primary = createKnex(successfulCheckup({pg_is_in_recovery: false}));
        const replicas = [0, 30, 60].map((latency) =>
            createKnex(successfulCheckup({pg_is_in_recovery: true}, latency)),
        );
        const unhealthyReplica = createKnex(failedCheckup);
        const {dispatcher} = createDispatcher([primary, ...replicas, unhealthyReplica], {
            balancingStrategy: {kind: 'round-robin'},
        });

        await dispatcher.ready();

        expect(pick(dispatcher, 'replica', 6)).toEqual([...replicas, ...replicas]);
    });

    test('keeps rotating evenly after the window shrinks', async () => {
        const {dispatcher, replicas} = createReplicaSet(3, {
            balancingStrategy: {kind: 'round-robin', latencyToleranceMs: 0},
        });

        await dispatcher.ready();
        setLatencies(dispatcher, [1, 1, 1, 1]);

        pick(dispatcher, 'replica', 2); // position now points at the third replica
        setLatencies(dispatcher, [1, 1, 1, 100]);

        expect(pick(dispatcher, 'replica', 4)).toEqual([
            replicas[0],
            replicas[1],
            replicas[0],
            replicas[1],
        ]);
    });

    test('proxy mode rotates both roles across proxies within the tolerance window', async () => {
        const proxies = [0, 1, 2].map(() => createKnex(successfulCheckup({value: 1})));
        const {dispatcher} = createDispatcher(proxies, {
            topologyMode: 'proxy',
            balancingStrategy: {kind: 'round-robin', latencyToleranceMs: 10},
        });

        await dispatcher.ready();
        setLatencies(dispatcher, [1, 5, 80]);

        for (const role of ['primary', 'replica']) {
            expect(new Set(pick(dispatcher, role, 4))).toEqual(new Set(proxies.slice(0, 2)));
        }
    });
});

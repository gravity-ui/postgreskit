/* eslint-env jest */

jest.mock('knex', () => jest.fn());

const knexBuilder = require('knex');

const {defaultDispatcherOptions} = require('../build/constants');
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

function createDispatcher(clients, options = {}) {
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

        expect(loggedErrorMessages(logger)).not.toEqual(
            expect.arrayContaining([
                'Multiple primary connections detected, something is wrong',
                'No alive replica available, using master for read',
            ]),
        );
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

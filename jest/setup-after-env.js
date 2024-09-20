require('events').EventEmitter.defaultMaxListeners = 1000;

const {db} = require('../examples/demo/build/db');

const {prepareTestDb} = require('./prepare-test-db');

global.beforeAll(async () => {
    await db.ready();

    await prepareTestDb();
});

global.afterAll(async () => {
    await db.terminate();
});

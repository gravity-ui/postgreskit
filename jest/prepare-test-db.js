const knexBuilder = require('knex');
const merge = require('lodash/merge');

const {knexOptions} = require('../examples/demo/build/db');
const {getTestDsnList} = require('../examples/demo/build/tests/constants');

const prepareTestDb = async () => {
    const testKnexOptions = merge({}, knexOptions, {
        connection: getTestDsnList(),
    });

    const knexInstance = knexBuilder(testKnexOptions);

    await knexInstance.raw(`
        DROP SCHEMA public CASCADE;
        CREATE SCHEMA public;
    `);

    await knexInstance.migrate.latest();
    await knexInstance.seed.run();

    await knexInstance.destroy();
};

module.exports = {prepareTestDb};

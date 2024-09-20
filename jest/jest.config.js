const {resolve} = require('path');
const jtcPreset = require('@trendyol/jest-testcontainers/jest-preset');

module.exports = {
    ...jtcPreset,
    rootDir: '../examples/demo/',
    testEnvironment: resolve(__dirname, './test-environment.js'),
    setupFilesAfterEnv: [resolve(__dirname, './setup-after-env.js')],
    testTimeout: 1000 * 500,
    testMatch: ['**/examples/demo/build/tests/**/(*.)+(test|spec).[tj]s'],
};

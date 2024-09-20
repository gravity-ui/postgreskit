'use strict';

const config = require('../.depdiffrc.json');
const mainDeps = require('../package.json');
const demoDeps = require('../examples/demo/package.json');

const excludedDeps = config.ignores;
function compare(depsA, depsB) {
    let errorCount = 0;
    Object.keys(depsA).forEach((key) => {
        if (depsB[key] && depsA[key] !== depsB[key] && !excludedDeps.includes(key)) {
            console.log(
                `${key} version mismatch
  demo example:  \x1b[31m${depsA[key]}\x1b[0m
  postgreskit:  \x1b[31m${depsB[key]}\x1b[0m\n`,
            );
            ++errorCount;
        }
    });

    return errorCount;
}

function getErrorMessage(type, count) {
    return count > 0
        ? `\x1b[31mLint ${type} finished with ${count} ${count > 1 ? 'errors' : 'error'} \x1b[0m\n`
        : `Lint ${type} finished with 0 errors\n`;
}

const dependenciesErrorCount = compare(demoDeps.dependencies, mainDeps.dependencies);
console.log(getErrorMessage('dependencies', dependenciesErrorCount));

const devDependenciesErrorCount = compare(demoDeps.devDependencies, mainDeps.devDependencies);
console.log(getErrorMessage('devDependencies', devDependenciesErrorCount));

const overridesErrorCount = compare(demoDeps.overrides ?? {}, mainDeps.overrides ?? {});
console.log(getErrorMessage('dependencies overrides', overridesErrorCount));

if (dependenciesErrorCount > 0 || devDependenciesErrorCount > 0 || overridesErrorCount > 0) {
    process.exit(1);
} else {
    console.log(`Lint dependencies versions done`);
    process.exit(0);
}

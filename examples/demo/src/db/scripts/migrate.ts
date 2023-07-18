import {helpers} from '../index';

helpers
    .migrateDatabase()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        // eslint-disable-next-line no-console
        console.error(error);
        process.exit(1);
    });

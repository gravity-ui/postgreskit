# PostgresKit

PostgresKit is a package for connecting to PostgreSQL. It includes the pg, Knex, and Objection libraries, as well as a multi-host connection module.

Working with it mostly involves the methods that are standard in Knex and Objection, so their documentation is still relevant.

[Knex]: http://knexjs.org
[Objection]: https://vincit.github.io/objection.js/

## Getting started

### Installing the package

```
npm install --save @gravity-ui/postgreskit
```

### Connecting to a project

```typescript
import {initDB} from '@gravity-ui/postgreskit';
import {knexSnakeCaseMappers} from 'objection';
import * as path from 'path';

export const {db, CoreBaseModel, helpers} = initDB({
  connectionString: process.env.POSTGRES_DSN_LIST,
  dispatcherOptions: {
    healthcheckInterval: 5000,
    healthcheckTimeout: 700,
    suppressStatusLogs: process.env.SUPPRESS_DB_STATUS_LOGS === 'true',
  },
  knexOptions: {
    ...knexSnakeCaseMappers(),
    migrations: {
      directory: path.resolve(__dirname, 'migrations'),
      tableName: 'migrations',
      extension: 'js',
      loadExtensions: ['.js'],
    },
    seeds: {
      directory: path.resolve(__dirname, 'seeds'),
      loadExtensions: ['.js'],
    },
    debug: process.env.SQL_DEBUG,
  },
  logger: {
    info(message, extra) {
      console.log(message, extra);
    },
    error(message, error, extra) {
      console.error(message, error, extra);
    },
  },
});
```

`initDB` options:

- `connectionString` is a set of [postgres connection strings](https://stackoverflow.com/questions/3582552/postgresql-connection-url) separated by a comma, with at least one host required, for example: `'postgresql://user:password@dbHost1:5432/dbName,postgresql://user:password@dbHost2:5432/dbName'`
- `logger`: Provide the `info` and `error` callbacks for logging messages
- `dispatcherOptions`: Settings for the primary/replica balancing (none of the options are required)
  - `healthcheckInterval`: Health check interval in milliseconds, default value: 5000ms
  - `healthcheckTimeout`: Health check interval in milliseconds, default value: 700ms
  - `suppressStatusLogs`: Boolean value that disables database health checks (useful for developers)
  - `beforeTerminate`: Function called before terminating a connection, must return a Promise
- `knexOptions`: Non-required additional options that will be passed to Knex before initialization

Here is the recommended project structure (we only list the directories that have to do with working with the database):

```
- src
  - db
    - index.ts
    - models
    - migrations
    - seeds
```

## Usage

The `initDB` constructor exports three elements: `db`, `CoreBaseModel`, and `helpers`. Let's take a closer look at each of them.

### db

`db`: Instance of the [PGDispatcher](https://github.yandex-team.ru/data-ui/postgreskit/blob/master/lib/dispatcher.ts) module responsible for primary/replica connection balancing. Under the hood, this module creates N instances of knex (N is the number of hosts passed in `connectionString`). From these instances, it polls the database hosts every `healthcheckInterval` milliseconds, requesting if they are primary hosts or replica hosts (using the `SELECT pg_is_in_recovery()` query).

Public `db` methods:

- `ready`: Function that returns a Promise that is resolved after the database connection has been established. This function is useful when you do not want to start query processing until the database is ready: for this, add `await db.ready(); next()` as middleware
- `terminate`: Terminates all connections and returns a Promise which is resolved after `knex.destroy()` executes for each connection
- `primary`: Getter that always points at the knex instance targeting the current primary host. If there is no primary host, when trying to access `db.primary`, you will get an error with the `ERR_DB_READ_ONLY` code
- `replica`: Getter that always points at the knex instance targeting the fastest available replica host. The speed is determined from the latest health-check query response time. If only the primary host is available, `db.replica` returns it, logging a warning about an attempt to read from the `primary` replica. If no host is available, `db.replica` throws an error with the `ERR_DB_UNAVAILABLE` code

Both `db.primary` and `db.replica` point to regular knex instances that can do everything described in the [knex documentation](https://knexjs.org/).

### CoreBaseModel

`CoreBaseModel`: Class that expands the basic `Model` from Objection using the methods that access `primary` and `replica` connections (static methods + instances). Objection classes in your application must inherit from `CoreBaseModel`:

```typescript
// src/db/models/entry.ts
import {CoreBaseModel} from '../';

export default class Entry extends CoreBaseModel {
  static get tableName() {
    return 'entries';
  }

  static get idColumn() {
    return 'id';
  }

  static async yourCustomMethod() {
    await Entry.query(this.replica).select().timeout(10000);
  }
}
```

Classes that are declared in this manner get access to all the methods described in the [Objection](https://vincit.github.io/objection.js/) documentation. The main distinction from knex/objection is the requirement to explicitly pass a pointer to the knex instance, in a query chain, e.g., `.query(this.primary)`. This is to ensure that queries are always sent to relevant hosts, with read queries made against replicas and write queries, against the master host.

To bypass this requirement, you can define your basic model and bind it to `db.primary` using `Model.knex(knex)`. Then you can extend this basic model to build other models in your application. However, we would not recommend this approach for applications that have any load, as it would direct all that load onto the primary host.

#### migrations

Migrations are placed in the `src/db/migrations` directory. Sample file:

```typescript
import type {Knex} from 'knex';

export function up(knex: Knex): Promise<unknown> {
  return knex.raw(`
        CREATE TABLE entries (content TEXT);
    `);
}

export function down(knex: Knex): Promise<unknown> {
  return knex.raw(`
        DROP TABLE entries;
    `);
}
```

`up` is called for each migration when you apply the scheme, and `down`, when you roll back the scheme. As an argument, both these functions accept a knex instance and must return a Promise.

#### seeds

For testing purposes, sometimes, you might need files for the initial population of your database. These files are placed in the `src/db/seeds` directory. Sample file:

```typescript
import type {Knex} from 'knex';

export async function seed(knex: Knex) => {
    return knex.raw(`INSERT INTO tenants (name) VALUES ('default');`);
}
```

### helpers

`helpers` are objects that include a set of useful functions for database preparation. These functions accept no arguments and return a Promise.

- `clearDatabase`: Rolls back the database schema to the zero version, clearing all its content
- `rollbackDatabase`: Rolls the database schema back by one batch
- `migrateDatabase`: Migrates the database to the latest schema version
- `prepareDatabase`: Populates the database by running scripts from the `seeds` directory (which is defined in the knex settings when initializing PostgresKit)

## Migrating from Knex & Objection

tl;dr about migration:

1. To your `connectionString`, add all connection strings of the database hosts, separated by a comma, for example: `'postgresql://user:password@dbHost1:5432/dbName,postgresql://user:password@dbHost2:5432/dbName'`
2. Take settings from `knexfile.js` and add them to the `initDB` call as `knexOptions` (do not add connection settings to the options because they are configured separately as `connectionString`)
   - You can delete `knexfile.js` after that: it can declare only one host but requires a separate primary host setting. In such a case, you will have to run migrations using helpers in PostgresKit. Alternatively, you can preserve the file and continue using knex cli
3. Inherit all your application models from `CoreBaseModel`
4. Use `this.primary` or `this.replica` in every query (example: `.query(this.primary)`) or bind the main model to `db.primary` (`Model.knex(knex)`)
5. For development purposes, set the `SUPPRESS_DB_STATUS_LOGS=true` environment variable

# Demo

### Install and build

```bash
npm ci

npm run build

cd ./examples/demo

npm ci
```

### Create database

```bash
sudo -u postgres createuser test_user

sudo -u postgres createdb test_postgreskit

sudo -u postgres psql

ALTER USER test_user WITH ENCRYPTED password 'test_user';

GRANT ALL PRIVILEGES ON DATABASE "test_postgreskit" to test_user;
```

### Create a migration if necessary

```bash
npm run migration:create -- migration_name
```

### Prepare database

```bash
npm run db:prepare
```

### Run dev server

```bash
npm run dev
```

### Check that the data is returned from the database

```bash
curl localhost:3033
```

export const testDbConfig = {
    user: 'test_user',
    password: 'test_user',
    dbName: 'test_postgreskit',
};

export const getTestDsnList = () => {
    const globals = global as unknown as {
        __TESTCONTAINERS_POSTGRE_IP__: string;
        __TESTCONTAINERS_POSTGRE_PORT_5432__: string;
    };
    return `postgres://${testDbConfig.user}:${testDbConfig.password}@${globals.__TESTCONTAINERS_POSTGRE_IP__}:${globals.__TESTCONTAINERS_POSTGRE_PORT_5432__}/${testDbConfig.dbName}`;
};

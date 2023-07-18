import {Knex} from 'knex';

export const seed = async (knex: Knex) => {
    const teachers = [
        {
            name: 'Dana Wilson',
            email: 'dana@school.edu',
            age: 34,
        },
        {
            name: 'Jack Par',
            email: 'jack@school.edu',
            age: 45,
        },
        {
            name: 'Mike Jackson',
            email: 'mike@school.edu',
            age: 23,
        },
        {
            name: 'Jessica Sanderson',
            email: 'jess@school.edu',
            age: 54,
        },
    ];

    return await Promise.all(
        teachers.map(async (teacher) => {
            return await knex('teachers').insert({...teacher});
        }),
    ).catch((err) => {
        throw err;
    });
};

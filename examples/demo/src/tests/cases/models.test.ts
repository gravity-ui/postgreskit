import {TeachersModel, TeachersModelColumn} from '../../db/models/teachers';

const data = {
    [TeachersModelColumn.Age]: 25,
    [TeachersModelColumn.Email]: 'mike.snow@school.edu',
    [TeachersModelColumn.Name]: 'Mike Snow',
};

describe('Models', () => {
    test('Insert teacher', async () => {
        const teacher = await TeachersModel.query(TeachersModel.primary)
            .insert(data)
            .returning('*')
            .timeout(TeachersModel.DEFAULT_QUERY_TIMEOUT);

        expect(teacher.toJSON()).toStrictEqual({
            ...data,
            [TeachersModelColumn.SchoolId]: expect.any(Number),
        });
    });
    test('Get inserted teacher', async () => {
        const teacher = await TeachersModel.query(TeachersModel.replica)
            .findOne({
                [TeachersModelColumn.Email]: data[TeachersModelColumn.Email],
            })
            .timeout(TeachersModel.DEFAULT_QUERY_TIMEOUT);

        expect(teacher?.toJSON()).toStrictEqual({
            ...data,
            [TeachersModelColumn.SchoolId]: expect.any(Number),
        });
    });
});

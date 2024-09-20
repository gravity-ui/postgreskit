import request from 'supertest';
import nodekitApp from '../..';

export const app = nodekitApp.express;

describe('Routes', () => {
    test('Get root route', async () => {
        const response = await request(app).get('/').expect(200);

        expect(response.body).toStrictEqual({
            school_id: expect.any(Number),
            name: expect.any(String),
            email: expect.any(String),
            age: expect.any(Number),
        });
    });
});

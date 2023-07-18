/* eslint-disable import/order */
import {ExpressKit} from '@gravity-ui/expresskit';
import {nodekit} from './nodekit';
import {TeachersModel} from './db/models/teachers';

const app = new ExpressKit(nodekit, {
    'GET /': {
        handler: async (_req, res) => {
            const teacher = await TeachersModel.query(TeachersModel.replica)
                .select()
                .first()
                .timeout(TeachersModel.DEFAULT_QUERY_TIMEOUT);

            res.send(teacher);
        },
    },
});

app.run();

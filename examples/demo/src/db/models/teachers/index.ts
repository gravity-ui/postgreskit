import {Model} from '../../';

export const TeachersModelColumn = {
    SchoolId: 'school_id',
    Name: 'name',
    Email: 'email',
    Age: 'age',
} as const;

export class TeachersModel extends Model {
    static get tableName() {
        return 'teachers';
    }

    static get idColumn() {
        return TeachersModelColumn.SchoolId;
    }

    [TeachersModelColumn.SchoolId]!: number;
    [TeachersModelColumn.Name]!: string;
    [TeachersModelColumn.Email]!: string;
    [TeachersModelColumn.Age]!: number;
}

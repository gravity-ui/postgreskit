import type {Model} from 'objection';
import type {PGDispatcher} from './dispatcher';

export type TopologyMode = 'primary-replica' | 'proxy';

export interface PDOptions {
    healthcheckInterval: number;
    healthcheckTimeout: number;
    healthcheckConsecutiveFailures?: number;
    suppressStatusLogs: boolean;
    beforeTerminate: () => Promise<void>;
    topologyMode: TopologyMode;
}

export type Dict = {[key: string]: unknown};

interface ExInfoLogger {
    (message: string, extra?: Dict): void;
}

interface ExErrorLogger {
    (message: string, error?: Error | unknown, extra?: Dict): void;
}

export interface ExLogger {
    info: ExInfoLogger;
    error: ExErrorLogger;
}

export declare class BaseModel extends Model {
    static set db(value: PGDispatcher);
    static get primary(): InstanceType<typeof PGDispatcher>['primary'];
    get primary(): InstanceType<typeof PGDispatcher>['primary'];
    static get replica(): InstanceType<typeof PGDispatcher>['replica'];
    get replica(): InstanceType<typeof PGDispatcher>['replica'];
}

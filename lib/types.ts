import type {Model} from 'objection';
import type {PGDispatcher} from './dispatcher';

export type TopologyMode = 'primary-replica' | 'proxy';

/**
 * always the connection with the lowest latest health-check latency;
 * among equally fast ones, the first in the connections list (default)
 */
export interface FastestBalancingStrategy {
    kind: 'fastest';
}

/**
 * every healthy connection in turn; with `latencyTolerance`, only those whose latest
 * health-check latency is within that many ms of the lowest one
 */
export interface RoundRobinBalancingStrategy {
    kind: 'round-robin';
    /**
     * latency window in ms: when set, only connections whose latest health-check latency
     * is within this value of the lowest one are rotated (0 — only the fastest ones).
     * When omitted, all healthy connections are rotated
     */
    latencyTolerance?: number;
}

export type BalancingStrategy = FastestBalancingStrategy | RoundRobinBalancingStrategy;

export interface PGConnectionStatus {
    readonly host: string;
    readonly healthy: boolean;
    readonly latency: number;
}

export type PGConnectionRole = 'primary' | 'replica' | 'unknown';

export interface PGPrimaryReplicaConnectionStatus extends PGConnectionStatus {
    readonly role: PGConnectionRole;
}

export interface PGPrimaryReplicaHealthcheckStatus {
    readonly topologyMode: 'primary-replica';
    readonly connections: readonly PGPrimaryReplicaConnectionStatus[];
}

export interface PGProxyHealthcheckStatus {
    readonly topologyMode: 'proxy';
    readonly connections: readonly PGConnectionStatus[];
}

export type PGHealthcheckStatus = PGPrimaryReplicaHealthcheckStatus | PGProxyHealthcheckStatus;

export type PGHealthcheckHandler = (status: PGHealthcheckStatus) => void;

export interface PDOptions {
    healthcheckInterval: number;
    healthcheckTimeout: number;
    suppressStatusLogs: boolean;
    /**
     * suppresses only [Database current status] logs, preserving dispatcher errors and other logs
     */
    suppressHealthcheckStatusLogs?: boolean;
    beforeTerminate: () => Promise<void>;
    topologyMode: TopologyMode;
    balancingStrategy?: BalancingStrategy;
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

export interface PDOptions {
    healthcheckInterval: number;
    healthcheckTimeout: number;
    suppressStatusLogs: boolean;
    beforeTerminate: () => Promise<void>;
}

export type Dict = {[key: string]: unknown};

interface ExInfoLogger {
    (message: string, extra?: Dict): void;
}

interface ExErrorLogger {
    (message: string, error?: Error | unknown, extra?: Dict): void;
}

export interface ExLogger {
    log: ExInfoLogger;
    logError: ExErrorLogger;
}

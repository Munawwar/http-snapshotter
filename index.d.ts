export type SnapshotText = {
    fileSuffixKey: string;
    requestType: 'json' | 'text';
    request: {
        method: string;
        url: string;
        headers: string[][];
        body: string | object | undefined;
    };
    responseType: 'text';
    response: {
        status: number;
        statusText: string;
        headers: string[][];
        body: string | undefined;
    };
};
export type SnapshotJson = {
    fileSuffixKey: string;
    requestType: 'json' | 'text';
    request: {
        method: string;
        url: string;
        headers: string[][];
        body: string | object | undefined;
    };
    responseType: 'json';
    response: {
        status: number;
        statusText: string;
        headers: string[][];
        body: object | undefined;
    };
};
export type Snapshot = SnapshotText | SnapshotJson;
export type ReadSnapshotReturnType = Promise<{
    snapshot: Snapshot;
    absoluteFilePath: string;
    fileName: string;
}>;
export type ClientRequestInterceptorType = import('@mswjs/interceptors/ClientRequest').ClientRequestInterceptor;
export type FetchInterceptorType = import('@mswjs/interceptors/fetch').FetchInterceptor;
/**
 * Write/read snapshots to/from a sub directory. This isolates snapshots for a test.
 * @param {string} directoryName Directory name relative to snapshot directory. It will be created if it doesn't exist.
 */
export function startTestCase(directoryName: string): void;
/**
 * Reset the directory to the root directory
 */
export function endTestCase(): void;
/**
 * @param {Request} request
 */
export function defaultSnapshotFileNameGenerator(request: Request): Promise<{
    filePrefix: string;
    fileSuffixKey: string;
}>;
/**
 * Attach snapshot filename generator function
 *
 * Here's your opportunity to uniquely identify a request with a snapshot file name.
 * The default generator uses HTTP method, slugified URL (check @sindresorhus/slugify
 * npm package) as the file name prefix
 * And <HTTP method>#<url>#<body text> concatenated as file name suffix key
 * (which then is SHA256 hashed and the hash is used as the actual file name suffix).
 *
 * Use cases (not limited to):
 * 1. if a request body has a dynamic random id or timestamp, you can remove it from
 * cache key computation
 * 2. if a specific test does not use the default snapshot, you can prefix the snapshot
 * file name for the test.
 *
 * WARNING: Attaching a function on a per-test basis may not be concurrent safe. i.e. If you tests
 * run sequentially, then it is safe. But if your test runner runs test suites concurrently,
 * then it is better to attach a function only once ever.
 * @param {(req: Request) => Promise<{ filePrefix: string, fileSuffixKey: string }>} func
 */
export function attachSnapshotFilenameGenerator(func: (req: Request) => Promise<{
    filePrefix: string;
    fileSuffixKey: string;
}>): void;
/** Reset snapshot filename generator to default */
export function resetSnapshotFilenameGenerator(): void;
/**
 * Start the interceptor
 * @param {object} opts
 * @param {string|null} opts.snapshotDirectory Full absolute path to snapshot directory
 */
export function start({ snapshotDirectory: _snapshotDirectory, }?: {
    snapshotDirectory: string | null;
}): void;
/** Stop the interceptor */
export function stop(): void;

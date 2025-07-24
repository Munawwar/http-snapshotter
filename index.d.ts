export type SnapshotFileInfo = {
    absoluteFilePath: string;
    /**
     * in format filePrefix-hash.json`
     */
    fileName: string;
    filePrefix: string;
    /**
     * The string that would be hashed to be suffixed to the snapshot file name
     */
    fileSuffixKey: string;
};
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
export type SnapshotBinary = {
    fileSuffixKey: string;
    requestType: 'json' | 'text';
    request: {
        method: string;
        url: string;
        headers: string[][];
        body: string | object | undefined;
    };
    responseType: 'binary';
    compression?: string | undefined;
    response: {
        status: number;
        statusText: string;
        headers: string[][];
        body: string;
    };
};
export type Snapshot = SnapshotText | SnapshotJson | SnapshotBinary;
export type DiffChange = import('diff').Change;
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
 * Default snapshot ignore rules - by default no requests are ignored
 * @param {Request} request
 * @returns {boolean}
 */
export function defaultSnapshotIgnoreRules(request: Request): boolean;
/**
 * Attach snapshot ignore rules function
 *
 * Here's your opportunity to define custom rules for ignoring requests from being snapshotted.
 * The function receives the Request object and should return true if the request should be ignored.
 *
 * IMPORTANT: Behavior varies by SNAPSHOT mode:
 * - SNAPSHOT=update/append: Ignored requests make real network calls but don't create snapshots
 * - SNAPSHOT=read: Ignored requests throw an error (tests shouldn't make real network calls)
 *
 * Use cases (not limited to):
 * 1. Ignore requests with specific headers (e.g., x-debug-mode: no-snapshot)
 * 2. Ignore requests to specific URLs or domains
 * 3. Ignore requests with specific HTTP methods
 * 4. Ignore requests based on request body content
 *
 * WARNING: Attaching a function on a per-test basis may not be concurrent safe. i.e. If your tests
 * run sequentially, then it is safe. But if your test runner runs test suites concurrently,
 * then it is better to attach a function only once ever.
 * @param {(req: Request) => boolean} func
 */
export function attachSnapshotIgnoreRules(func: (req: Request) => boolean): void;
/** Reset snapshot ignore rules to default (no requests ignored) */
export function resetSnapshotIgnoreRules(): void;
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

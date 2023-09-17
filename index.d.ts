export type SnapshotText = {
    responseType: 'text';
    fileSuffixKey: string;
    request: {
        method: string;
        url: string;
        headers: string[][];
        body: string | undefined;
    };
    response: {
        status: number;
        statusText: string;
        headers: string[][];
        body: string | undefined;
    };
};
export type SnapshotJson = {
    responseType: 'json';
    fileSuffixKey: string;
    request: {
        method: string;
        url: string;
        headers: string[][];
        body: string | undefined;
    };
    response: {
        status: number;
        statusText: string;
        headers: string[][];
        body: object | undefined;
    };
};
export type Snapshot = SnapshotText | SnapshotJson;
export type ClientRequestInterceptorType = import('@mswjs/interceptors/ClientRequest').ClientRequestInterceptor;
export type FetchInterceptorType = import('@mswjs/interceptors/fetch').FetchInterceptor;
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
 * Attach response transformer function.
 *
 * Here is an opportunity to modify the response (loaded from snapshot) on-the-fly right before
 * the response is sent to consumers.
 *
 * WARNING: Attaching a function on a per-test basis may not be concurrent safe. i.e. If you tests
 * run sequentially, then it is safe. But if your test runner runs test suites concurrently,
 * then it is better to attach a function only once ever.
 * @param {(response: Response, request: Request) => Promise<Response>} func
 */
export function attachResponseTransformer(func: (response: Response, request: Request) => Promise<Response>): void;
/** Reset response transformer */
export function resetResponseTransformer(): void;
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

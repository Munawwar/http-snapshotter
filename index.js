/* eslint-disable import/no-extraneous-dependencies, no-console */
/**
 * How to use:
 * Place file in directory as tests and add `require('./snapshotter').start()` before tests begin
 *
 * WARNING: This snapshotter is not thread-safe. Only will work with test runners like tape where
 * tests run on single threads.
 *
 * Run tests with environment variable SNAPSHOT=update first time to create snapshots
 * SNAPSHOT=update <test runner command>
 * e.g. SNAPSHOT=update tape tests/**\/*.js | tap-diff
 *
 * Here onwards run test runner without SNAPSHOT env variable or SNAPSHOT=read
 * You can use SNAPSHOT=ignore to neither read not write snapshots, for testing on real
 * network operations.
 *
 * Unused snapshot files will be written into a log file named 'unused-snapshots.log'.
 * You can delete those files manually.
 *
 * Log requests with LOG_REQ=1 env variable
 * or node.js built-in NODE_DEBUG=http,http2
 *
 * More docs at the end of this file, find the exported methods.
 */
// Tested with @mswjs/interceptors v0.24.1
const { BatchInterceptor } = require('@mswjs/interceptors');
const { ClientRequestInterceptor } = require('@mswjs/interceptors/ClientRequest');
const { FetchInterceptor } = require('@mswjs/interceptors/fetch');
const slugify = require('@sindresorhus/slugify');
const { createHash } = require('node:crypto');
const { promises: fs } = require('node:fs');
const { resolve } = require('node:path');

// Environment variable SNAPSHOT = update / ignore / read (default)
const SNAPSHOT = process.env.SNAPSHOT || 'read';
const LOG_REQ = process.env.LOG_REQ === '1' || process.env.LOG_REQ === 'true';
const unusedSnapshotsLogFile = 'unused-snapshots.log';
/**
 * @type {import("node:fs").PathLike | null}
 */
let snapshotDirectory = null;

/**
 * @typedef SnapshotText
 * @property {string} fileSuffixKey
 * @property {'json'|'text'} requestType
 * @property {object} request
 * @property {string} request.method
 * @property {string} request.url
 * @property {string[][]} request.headers
 * @property {string|object|undefined} request.body
 * @property {'text'} responseType
 * @property {object} response
 * @property {number} response.status
 * @property {string} response.statusText
 * @property {string[][]} response.headers
 * @property {string|undefined} response.body
 */
/**
 * @typedef SnapshotJson
 * @property {string} fileSuffixKey
 * @property {'json'|'text'} requestType
 * @property {object} request
 * @property {string} request.method
 * @property {string} request.url
 * @property {string[][]} request.headers
 * @property {string|object|undefined} request.body
 * @property {'json'} responseType
 * @property {object} response
 * @property {number} response.status
 * @property {string} response.statusText
 * @property {string[][]} response.headers
 * @property {object|undefined} response.body
 */

/**
 * @typedef {SnapshotText | SnapshotJson} Snapshot
 */

/** @type {(res: any) => any} */
const identity = (response) => response;

const defaultKeyDerivationProps = ['method', 'url', 'body'];
/**
 * @param {Request} request 
 */
async function defaultSnapshotFileNameGenerator(request) {
  const url = new URL(request.url);
  const filePrefix = [
    request.method.toLowerCase(),
    slugify(url.hostname),
    slugify(url.pathname.replace('.json', '')),
  ].filter(Boolean).join('-');

  // Input data
  const dataList = await Promise.all(
    defaultKeyDerivationProps.map((key) => {
      if (key === 'body') {
        return request.clone().text();
      }
      // @ts-ignore
      return request[key];
    }),
  );

  return {
    filePrefix,
    fileSuffixKey: dataList.join('#'),
  };
}

// Dynamically changeable props
/**
 * @type {(response: Response, request: Request) => Promise<Response>}
 */
let responseTransformer = identity;
/**
 * @type {(req: Request) => Promise<{ filePrefix: string, fileSuffixKey: string }>}
 */
let snapshotFileNameGenerator = defaultSnapshotFileNameGenerator;

/**
 * @param {Request} request
 */
async function getSnapshotFileName(request) {
  const { fileSuffixKey, filePrefix } = await snapshotFileNameGenerator(request.clone());

  // 15 characters are enough for uniqueness
  const hash = createHash('sha256')
    .update(fileSuffixKey)
    .digest('base64url')
    .slice(0, 15);

  const fileName = `${filePrefix}-${hash}.json`;

  return {
    absoluteFilePath: resolve(/** @type {string} */ (snapshotDirectory), fileName),
    fileName,
    filePrefix,
    fileSuffixKey,
  };
}

// NOTE: This isn't going to work on a test runner that uses multiple processes / workers
/**
 * @typedef {Promise<{
 *  snapshot: Snapshot,
 *  absoluteFilePath: string,
 *  fileName: string
 * }>} ReadSnapshotReturnType
 */
/** @type {Map<string, ReadSnapshotReturnType>} */
const alreadyWrittenFiles = new Map();
const readFiles = new Set();

/**
 * @param {Request} request
 * @param {Response} response
 */
async function saveSnapshot(request, response) {
  const { absoluteFilePath, fileName, fileSuffixKey } = await getSnapshotFileName(request);
  // console.log(fileName);

  // Prevent multiple tests from having same snapshot
  if (alreadyWrittenFiles.has(absoluteFilePath)) {
    return /** @type {ReadSnapshotReturnType} */ (alreadyWrittenFiles.get(absoluteFilePath));
  }

  /** @returns {ReadSnapshotReturnType} */
  const saveFreshSnapshot = async () => {
    let requestBody;
    let responseBody;

    /** @type {'text' | 'json'} */
    let requestType;
    const reqContentType = request.headers.get('content-type') || '';
    if (reqContentType.includes('application/json') || reqContentType.includes('application/x-amz-json-1.0')) {
      try {
        requestBody = await request.clone().json();
        requestType = 'json';
      } catch (err) {
        requestBody = await request.clone().text();
        requestType = 'text';
      }
    } else {
      requestBody = await request.clone().text();
      requestType = 'text';
    }

    /** @type {'text' | 'json'} */
    let responseType;
    const resContentType = response.headers.get('content-type') || '';
    if (resContentType.includes('application/json') || resContentType.includes('application/x-amz-json-1.0')) {
      try {
        responseBody = await response.clone().json();
        responseType = 'json';
      } catch (err) {
        responseBody = await response.clone().text();
        responseType = 'text';
      }
    } else {
      responseBody = await response.clone().text();
      responseType = 'text';
    }
    /** @type {Snapshot} */
    const snapshot = {
      requestType,
      request: {
        method: request.method,
        url: request.url,
        headers: [...request.headers.entries()],
        body: requestBody,
      },
      responseType,
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers.entries()],
        body: responseBody,
      },
      fileSuffixKey,
    };
    const json = JSON.stringify(snapshot, null, 2);
    await fs.writeFile(absoluteFilePath, json, 'utf-8');
    return { snapshot, absoluteFilePath, fileName };
  };

  const savePromise = saveFreshSnapshot();
  alreadyWrittenFiles.set(absoluteFilePath, savePromise);
  return savePromise;
}

/** @type {Record<string, Snapshot>} */
const snapshotCache = {};

/**
 * @param {Request} request
 */
async function readSnapshot(request) {
  const { absoluteFilePath, fileName, fileSuffixKey } = await getSnapshotFileName(request);
  // console.log(fileName);

  if (!snapshotCache[absoluteFilePath]) {
    let json;
    try {
      json = await fs.readFile(absoluteFilePath, 'utf-8');
    } catch (err) {
      // Fail any test that fires a real network request (without snapshot)
      // @ts-ignore
      if (err.code === 'ENOENT') {
        const reqBody = await request.clone().text();
        console.error('No network snapshot found for request with cache keys:', {
          request: {
            url: request.url,
            method: request.method,
            headers: Object.fromEntries([...request.headers.entries()]),
            body: reqBody,
          },
          wouldBeFileSuffixKey: fileSuffixKey,
          wouldBeFileName: fileName,
        });
        throw new Error('Network request not mocked');
      } else {
        // @ts-ignore
        console.error('Error reading network snapshot file:', err.message);
        throw err;
      }
    }
    snapshotCache[absoluteFilePath] = JSON.parse(json);
    readFiles.add(fileName);
  }

  const snapshot = snapshotCache[absoluteFilePath];
  return { snapshot, absoluteFilePath, fileName };
}

/**
 * @param {Request} request
 * @param {Snapshot} snapshot
 */
async function sendResponse(request, snapshot) {
  const {
    responseType,
    response: {
      status,
      statusText,
      headers,
      body,
    },
  } = snapshot;

  let newResponse = new Response(
    responseType === 'json'
      ? JSON.stringify(body)
      : /** @type {string} */ (body),
    {
      status,
      statusText,
      headers: new Headers(/** @type HeadersInit */ (headers)),
    },
  );

  newResponse = await responseTransformer(newResponse, request);

  // respondWith is a method added by @mswjs/interceptors
  // @ts-ignore
  request.respondWith(newResponse);
  return newResponse;
}

/**
 * @param {Request} request
 */
async function readSnapshotAndSendResponse(request) {
  const { snapshot } = await readSnapshot(request);
  return sendResponse(request, snapshot);
}

/**
 * @param {Request} request
 * @param {Response} response
 */
async function saveSnapshotAndSendResponse(request, response) {
  const { snapshot } = await saveSnapshot(request, response);
  return sendResponse(request, snapshot);
}

/** @typedef {import('@mswjs/interceptors/ClientRequest').ClientRequestInterceptor} ClientRequestInterceptorType */
/** @typedef {import('@mswjs/interceptors/fetch').FetchInterceptor} FetchInterceptorType */
/**
 * @type {import('@mswjs/interceptors').BatchInterceptor<(ClientRequestInterceptorType|FetchInterceptorType)[]>|null}
 */
let interceptor = null;

let beforeExitEventSeen = false;
let unusedFiles;
process.on('beforeExit', async () => {
  if (SNAPSHOT === 'read' && !beforeExitEventSeen) {
    beforeExitEventSeen = true;
    let files;
    try {
      // @ts-ignore
      files = await fs.readdir(snapshotDirectory);
    } catch (err) {
      return;
    }
    let dir = /** @type {string} */(snapshotDirectory);
    unusedFiles = files.filter((file) => !readFiles.has(file) && file !== unusedSnapshotsLogFile);
    if (unusedFiles.length) {
      await fs
        .writeFile(
          resolve(dir, unusedSnapshotsLogFile),
          unusedFiles.join('\n'),
          'utf-8',
        )
        .catch((err) => console.error(err));
    } else {
      await fs
        .unlink(resolve(dir, unusedSnapshotsLogFile))
        .catch((err) => {
          if (err.code !== 'ENOENT') {
            console.error(err);
          }
        });
    }
  }
});

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
function attachSnapshotFilenameGenerator(func) {
  snapshotFileNameGenerator = func;
}

/** Reset snapshot filename generator to default */
function resetSnapshotFilenameGenerator() {
  snapshotFileNameGenerator = defaultSnapshotFileNameGenerator;
}

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
function attachResponseTransformer(func) {
  responseTransformer = func;
}

/** Reset response transformer */
function resetResponseTransformer() {
  responseTransformer = identity;
}

/**
 * Start the interceptor
 * @param {object} opts
 * @param {string|null} opts.snapshotDirectory Full absolute path to snapshot directory
 */
function start({
  snapshotDirectory: _snapshotDirectory = null,
} = { snapshotDirectory: null }) {
  if (!_snapshotDirectory) {
    throw new Error('Please specify full path to a directory for storing/reading snapshots');
  }
  snapshotDirectory = _snapshotDirectory;
  /**
   * @type {Promise<any>|undefined}
   */
  let dirCreatePromise;

  interceptor = new BatchInterceptor({
    name: 'http-snapshotter-interceptor',
    interceptors: [
      new ClientRequestInterceptor(),
      new FetchInterceptor(),
    ],
  });

  // @ts-ignore
  interceptor.on('request', async ({ request }) => {
    if (SNAPSHOT === 'read') {
      await readSnapshotAndSendResponse(request);
    }
  });
  interceptor.on(
    // @ts-ignore
    'response',
    /** @type {(params: { request: Request, response: Response }) => Promise<void>} */
    async ({ request, response }) => {
      if (LOG_REQ) {
        const { fileName, fileSuffixKey } = await getSnapshotFileName(request);
        console.debug('Request', {
          request: {
            url: request.url,
            method: request.method,
            headers: Object.fromEntries([...request.headers.entries()]),
            body: await request.clone().text(),
          },
          wouldBeFileName: fileName,
          wouldBeFileSuffixKey: fileSuffixKey,
        });
      }
      if (SNAPSHOT === 'update') {
        if (!dirCreatePromise) {
          dirCreatePromise = fs.mkdir( /** @type {string} */(snapshotDirectory), { recursive: true });
        }
        await dirCreatePromise;
        await saveSnapshotAndSendResponse(request, response);
      }
    },
  );
  interceptor.apply();
}

/** Stop the interceptor */
function stop() {
  if (interceptor) {
    interceptor.dispose();
    interceptor = null;
  }
}

// Singleton - as it makes sense only one interceptor be active at any given moment.
module.exports = {
  defaultSnapshotFileNameGenerator,
  attachSnapshotFilenameGenerator,
  resetSnapshotFilenameGenerator,
  attachResponseTransformer,
  resetResponseTransformer,
  start,
  stop,
};
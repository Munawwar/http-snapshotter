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
 * Here onwards run test runner without SNAPSHOT env variable or SNAPSHOT=read.
 * For adding new snapshots without touching existing snapshots use SNAPSHOT=append.
 *
 * You can use SNAPSHOT=ignore to neither read not write snapshots, for testing on real
 * network operations.
 * 
 * Log read/saved snapshots by setting LOG_SNAPSHOT=1 env variable.
 *
 * Unused snapshot files will be written into a log file named 'unused-snapshots.log'.
 * You can delete those files manually.
 * 
 * Log requests with LOG_REQ=1 or LOG_REQ=summary (to just print summary) or LOG_REQ=detailed
 * (to print request details) env variable or node.js built-in NODE_DEBUG=http,http2
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
const { resolve, dirname, relative } = require('node:path');

// Environment variable SNAPSHOT = update / append / ignore / read (default)
const SNAPSHOT = process.env.SNAPSHOT || 'read';
const { LOG_REQ, LOG_SNAPSHOT } = process.env;
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

const dynamodbHostNameRegex = /^dynamodb\.(.+)\.amazonaws\.com$/;

const defaultKeyDerivationProps = ['method', 'url', 'body'];
/**
 * @param {Request} request 
 */
async function defaultSnapshotFileNameGenerator(request) {
  let filePrefix;

  const url = new URL(request.url);
  const matches = url.hostname.match(dynamodbHostNameRegex)
  if (matches) {
    filePrefix = [
      'dynamodb',
      matches[1], // e.g. eu-west-1
      slugify(request.headers?.get?.('x-amz-target')?.split?.('.')?.pop?.() || ''),
      slugify(JSON.parse(await request.clone().text())?.TableName),
    ].filter(Boolean).join('-');
  } else {
    filePrefix = [
      request.method.toLowerCase(),
      slugify(url.hostname),
      slugify(url.pathname.replace('.json', '')),
    ].filter(Boolean).join('-');
  }

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
 * @type {(req: Request) => Promise<{ filePrefix: string, fileSuffixKey: string }>}
 */
let snapshotFileNameGenerator = defaultSnapshotFileNameGenerator;
let snapshotSubDirectory = '';

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

  const fileName = `${snapshotSubDirectory ? `${snapshotSubDirectory}/` : ''}${filePrefix}-${hash}.json`;

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
const existingSubDirectories = new Set();

/**
 * @param {object} param
 * @param {Request} param.request
 * @param {Response} param.response
 * @param {string} param.absoluteFilePath
 * @param {string} param.fileName
 * @param {string} param.fileSuffixKey
 */
async function saveSnapshot({
  request,
  response,
  absoluteFilePath,
  fileName,
  fileSuffixKey,
}) {
  // Prevent multiple tests from having same snapshot
  if (alreadyWrittenFiles.has(absoluteFilePath)) {
    return /** @type {ReadSnapshotReturnType} */ (alreadyWrittenFiles.get(absoluteFilePath));
  }

  if (LOG_SNAPSHOT) {
    console.debug('Writing:', fileName);
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
    const dir = dirname(absoluteFilePath);
    if (!existingSubDirectories.has(dir)) {
      existingSubDirectories.add(dir);
      await fs.mkdir(dir, { recursive: true });
    }
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

  if (!snapshotCache[absoluteFilePath]) {
    if (LOG_SNAPSHOT) {
      console.debug('Reading:', fileName);
    }
    let json;
    try {
      json = await fs.readFile(absoluteFilePath, 'utf-8');
    } catch (err) {
      // Fail any test that fires a real network request (without snapshot)
      // @ts-ignore
      if (err.code === 'ENOENT') {
        if (SNAPSHOT === 'append') return {};
        const reqBody = await request.clone().text();
        console.error('No network snapshot found for request with cache keys:', {
          request: {
            url: request.url,
            method: request.method,
            headers: Object.fromEntries([...request.headers.entries()]),
            body: reqBody,
          },
          fileName,
          fileSuffixKey,
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

  const newResponse = new Response(
    responseType === 'json'
      ? JSON.stringify(body)
      : /** @type {string} */ (body),
    {
      status,
      statusText,
      headers: new Headers(/** @type HeadersInit */ (headers)),
    },
  );

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
  if (snapshot) {
    return sendResponse(request, snapshot);
  }
  return undefined;
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
    const dir = /** @type {string} */(snapshotDirectory);
    /** @type {import('node:fs').Dirent[]} */
    let files;
    try {
      files = await fs.readdir(dir, { recursive: true, withFileTypes: true });
    } catch (err) {
      return;
    }
    unusedFiles = files
      .filter((file) => file.isFile())
      .map((file) => relative(dir, resolve(file.path, file.name)))
      .filter((file) => (!readFiles.has(file) && file !== unusedSnapshotsLogFile)); 
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
 * Write/read snapshots to/from a sub directory. This isolates snapshots for a test.
 * @param {string} directoryName Directory name relative to snapshot directory. It will be created if it doesn't exist.
 */
function startTestCase(directoryName) {
  if (snapshotSubDirectory) {
    throw new Error(`Cannot start test case '${directoryName}' as test case '${snapshotSubDirectory}' is already running.`); 
  }
  snapshotSubDirectory = directoryName;
}
/**
 * Reset the directory to the root directory
 */
function endTestCase() {
  snapshotSubDirectory = '';
}

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
    if (['read', 'append'].includes(SNAPSHOT)) {
      await readSnapshotAndSendResponse(request);
    }
  });
  interceptor.on(
    // @ts-ignore
    'response',
    /** @type {(params: { request: Request, response: Response }) => Promise<void>} */
    async ({ request, response }) => {
      const { absoluteFilePath, fileName, fileSuffixKey } = await getSnapshotFileName(request);
      if (LOG_REQ) {
        const summary = `----------\n${request.method} ${request.url}\nWould use file name: ${fileName}`;
        if (LOG_REQ === '1' || LOG_REQ === 'summary') {
          console.debug(summary);
        } else if (LOG_REQ === 'detailed') {
          console.debug(`${summary}\n----------\n`, {
            request: {
              url: request.url,
              method: request.method,
              headers: Object.fromEntries([...request.headers.entries()]),
              body: await request.clone().text(),
            },
            response: {
              status: response.status,
              statusText: response.statusText,
              headers: Object.fromEntries([...response.headers.entries()]),
              body: await response.clone().text(),
            },
            wouldUseFileSuffixKey: fileSuffixKey,
          });
        }
      }
      if (SNAPSHOT === 'update' || (SNAPSHOT === 'append' && !readFiles.has(fileName))) {
        if (!dirCreatePromise) {
          dirCreatePromise = fs.mkdir( /** @type {string} */(snapshotDirectory), { recursive: true });
        }
        await dirCreatePromise;
        await saveSnapshot({
          request, response, absoluteFilePath, fileName, fileSuffixKey,
        });
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
  startTestCase,
  endTestCase,
  defaultSnapshotFileNameGenerator,
  attachSnapshotFilenameGenerator,
  resetSnapshotFilenameGenerator,
  start,
  stop,
};
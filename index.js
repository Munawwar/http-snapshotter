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
 * To ignore specific requests from being snapshotted in SNAPSHOT=update or SNAPSHOT=append mode,
 * use attachSnapshotIgnoreRules() to provide a function that receives the request object and
 * returns true if the request should be ignored from snapshotting.
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
const { BatchInterceptor, RequestController } = require('@mswjs/interceptors');
const { ClientRequestInterceptor } = require('@mswjs/interceptors/ClientRequest');
const { FetchInterceptor } = require('@mswjs/interceptors/fetch');
const slugify = require('@sindresorhus/slugify');
const { createHash } = require('node:crypto');
const { promises: fs } = require('node:fs');
const { resolve, dirname, relative, basename, join } = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { diffChars } = require('diff');

const gzip = promisify(zlib.gzip);
const brotliCompress = promisify(zlib.brotliCompress);
const deflate = promisify(zlib.deflate);

// Environment variable SNAPSHOT = update / append / ignore / read (default)
const SNAPSHOT = process.env.SNAPSHOT || 'read';
const { LOG_REQ, LOG_SNAPSHOT } = process.env;
const unusedSnapshotsLogFile = 'unused-snapshots.log';
/**
 * @type {string | null}
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

/**
 * @typedef {import('diff').Change} DiffChange
 */

const dynamodbHostNameRegex = /^(?:dynamodb|\d+\.ddb)\.([^.]+)\.amazonaws\.com$/;

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
      slugify(request.headers?.get?.('x-amz-target')?.split?.('.')?.pop?.() || ''), // e.g. get-item, put-item
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
      //@ts-ignore
      return request[key];
    }),
  );

  return {
    filePrefix,
    fileSuffixKey: dataList.join('#'),
  };
}

/**
 * Default snapshot ignore rules - by default no requests are ignored
 * @param {Request} request 
 * @returns {boolean}
 */
function defaultSnapshotIgnoreRules(request) {
  return false;
}

// Dynamically changeable props
/**
 * @type {(req: Request) => Promise<{ filePrefix: string, fileSuffixKey: string }>}
 */
let snapshotFileNameGenerator = defaultSnapshotFileNameGenerator;
let snapshotSubDirectory = '';

/**
 * @type {(req: Request) => boolean}
 */
let snapshotIgnoreRules = defaultSnapshotIgnoreRules;

/**
 * @typedef SnapshotFileInfo
 * @property {string} absoluteFilePath
 * @property {string} fileName in format filePrefix-hash.json`
 * @property {string} filePrefix
 * @property {string} fileSuffixKey The string that would be hashed to be suffixed to the snapshot file name
 */

/**
 * @param {Request} request
 * @returns {Promise<SnapshotFileInfo>}
 */
async function getSnapshotFileInfo(request) {
  const { fileSuffixKey, filePrefix } = await snapshotFileNameGenerator(request.clone());

  // 15 characters are enough for uniqueness
  const hash = createHash('sha256')
    .update(fileSuffixKey)
    .digest('base64url')
    .slice(0, 15);

  const fileName = join(snapshotSubDirectory, `${filePrefix}-${hash}.json`);

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
 * @param {Request} request
 * @param {Response} response
 * @param {SnapshotFileInfo} snapshotFileInfo
 */
async function saveSnapshot(request, response, snapshotFileInfo) {
  const { absoluteFilePath, fileName, fileSuffixKey } = snapshotFileInfo;
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

// ANSI color codes
const colors = {
  redBg: '\x1b[41m',
  greenBg: '\x1b[42m',
  white: '\x1b[37m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  reset: '\x1b[0m'
};

/** @type {Record<string, Snapshot>} */
const snapshotCache = {};

/**
 * @param {Request} request
 * @param {SnapshotFileInfo} snapshotFileInfo
 */
async function readSnapshot(request, snapshotFileInfo) {
  const { absoluteFilePath, fileName, fileSuffixKey } = snapshotFileInfo;
  const currentSnapshotDirectory = snapshotDirectory !== null && snapshotSubDirectory
    ? resolve(snapshotDirectory, snapshotSubDirectory)
    : snapshotDirectory;

  if (!snapshotCache[absoluteFilePath]) {
    if (LOG_SNAPSHOT) {
      console.debug('Reading:', fileName);
    }
    let json;
    try {
      json = await fs.readFile(absoluteFilePath, 'utf-8');
    } catch (err) {
      // Fail any test that fires a real network request (without snapshot)
      //@ts-ignore
      if (err.code === 'ENOENT') {
        if (SNAPSHOT === 'append') return {};
        const match = await findClosestSnapshotFile(currentSnapshotDirectory, snapshotFileInfo);
        const reqBody = await request.clone().text();
        const debuggingHelperMessage = (match ? [
          ...(match.fileSuffixKey === fileSuffixKey ? [
            `\n${colors.yellow}Found a snapshot file with same file suffix key:${colors.reset} ${join(snapshotSubDirectory, match.file)}. ${colors.yellow}Was the snapshot file manually renamed?${colors.reset}`,
            `${colors.yellow}Below is the diff between the current snapshot's file name versus what should be the new snapshot file name:${colors.reset}`,
            showColoredDiff(diffChars(fileName, join(snapshotSubDirectory, match.file)))
          ] : [
            `\n${colors.yellow}Maybe request has a had a minor change from previous snapshot? Closest snapshot file in similarity:${colors.reset} ${join(snapshotSubDirectory, match.file)}`,
            `${colors.yellow}Below is the diff between the two's fileSuffixKey that is used for computing the hash of the file name:${colors.reset}`,
            showColoredDiff(match.differences),
          ]),
          '',
        ] : []).join('\n');
        console.error(
          `${colors.red}No network snapshot found for following request:${colors.reset}`, 
          {
            expectedSnapshotFileName: fileName,
            request: {
              url: request.url,
              method: request.method,
              headers: Object.fromEntries([...request.headers.entries()]),
              body: reqBody,
            },
            fileSuffixKey,
          }, 
          debuggingHelperMessage
        );
        throw new Error('Network request not mocked');
      } else {
        //@ts-ignore
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

/** @type {{ [snapshotFile: string]: Snapshot }} */
const existingSnapshotFilesSuffixKeys = {};
/**
 * @param {string|null} snapshotDirectory
 * @param {SnapshotFileInfo} snapshotFileInfo
 * @returns {Promise<{ file: string, fileSuffixKey: string, differences: DiffChange[] } | null>}
 */
async function findClosestSnapshotFile(snapshotDirectory, { filePrefix, fileSuffixKey }) {
  if (SNAPSHOT !== 'read' || snapshotDirectory === null) return null;
  const filesWithSamePrefix = (await readExistingSnapshotFilesList(snapshotDirectory))
    .filter(file => basename(file).startsWith(`${filePrefix}-`));
  const fileContents = (
    await Promise.all(filesWithSamePrefix.map(async (file) => {
      const absolutePath = resolve(snapshotDirectory, file);
      if (!existingSnapshotFilesSuffixKeys[absolutePath]) {
        existingSnapshotFilesSuffixKeys[absolutePath] = /** @type {Snapshot} */ (
          JSON.parse(await fs.readFile(absolutePath, 'utf-8'))
        )
      }
      return existingSnapshotFilesSuffixKeys[absolutePath];
    }))
  ).map((snapshot, index) => ({
    file: filesWithSamePrefix[index],
    fileSuffixKey: snapshot.fileSuffixKey,
  }));

  /** @type {{ file: string, fileSuffixKey: string, differences: DiffChange[] } | null} */
  let closestMatch = null;
  let smallestDiff = Infinity;
  
  fileContents.forEach((item) => {
    const differences = diffChars(item.fileSuffixKey, fileSuffixKey);
    const totalChars = differences.reduce((sum, part) => sum + part.value.length, 0);
    const diffRatio = differences
      .filter(d => d.added || d.removed)
      .reduce((sum, part) => sum + part.value.length, 0) / totalChars;

    if (diffRatio < 0.5 && diffRatio < smallestDiff) {
      smallestDiff = diffRatio;
      closestMatch = {
        ...item,
        differences
      };
    }
  });

  return closestMatch;
}

/** @type {{ [dir: string]: string[] }} */
const existingSnapshotFilesList = {};
/**
 * @param {string|null} snapshotDirectory
 */
async function readExistingSnapshotFilesList(snapshotDirectory) {
  if (snapshotDirectory === null) return [];
  const dir = /** @type {string} */(snapshotDirectory);
  if (!existingSnapshotFilesList[dir]) {
    /** @type {import('node:fs').Dirent[]} */
    let files;
    try {
      files = await fs.readdir(dir, { recursive: true, withFileTypes: true });
    } catch (err) {
      return [];
    }
    existingSnapshotFilesList[dir] = files
        .filter((file) => file.isFile())
        .map((file) => relative(dir, resolve(file.path, file.name)))
  }
  return existingSnapshotFilesList[dir];
}

/**
 * @param {DiffChange[]} differences 
 */
function showColoredDiff(differences) {
  let output = '';
  differences.forEach(part => {
    if (part.added) {
      output += colors.greenBg + colors.white + part.value + colors.reset;
    } else if (part.removed) {
      output += colors.redBg + colors.white + part.value + colors.reset;
    } else {
      output += part.value;
    }
  });
  return output;
}

/**
 * @param {RequestController} controller
 * @param {Snapshot} snapshot
 */
async function sendResponse(controller, snapshot) {
  const {
    responseType,
    response: {
      status,
      statusText,
      headers,
      body,
    },
  } = snapshot;

  /** @type {string} */
  let encodedBody = responseType === 'json'
    ? JSON.stringify(body)
    : /** @type {string} */ (body || '');
  /** @type {Buffer} */
  let bufferBody;
  const contentEncoding = headers.find(tuple => tuple[0]?.toLowerCase() === 'content-encoding');

  if (contentEncoding) {
    if (contentEncoding[1].includes('br')) {
      bufferBody = await brotliCompress(encodedBody);
    } else if (contentEncoding[1].includes('gzip')) {
      bufferBody = await gzip(encodedBody);
    } else if (contentEncoding[1].includes('deflate')) {
      bufferBody = await deflate(encodedBody);
    } else if (contentEncoding[1].includes('compress')) {
      // Most servers don't send compress responses and node.js
      // doesn't have built-in compress support even for fetch().
      throw new Error('compress encoding not supported');
    } else if (contentEncoding[1].includes('zstd')) {
      // Node.js doesn't have built-in zstd support at the moment
      throw new Error('zstd encoding not supported');
    } else {
      // Unknown content-encoding fallback
      bufferBody = Buffer.from(encodedBody);
    }
  } else {
    bufferBody = Buffer.from(encodedBody)
  }

  const newResponse = new Response(
    bufferBody,
    {
      status,
      statusText,
      headers: new Headers(/** @type HeadersInit */ (headers.map((tuple) => {
        // We reformatted the json and removed spaces, so it's content-length may not be same as original
        if (tuple[0] === 'content-length' && responseType === 'json') {
          return [tuple[0], bufferBody.byteLength];
        }
        return tuple;
      }))),
    },
  );
  //@ts-ignore
  controller.respondWith(newResponse);
  return newResponse;
}

/**
 * @param {Request} request
 * @param {RequestController} controller
 * @param {SnapshotFileInfo} snapshotFileInfo
 */
async function readSnapshotAndSendResponse(request, controller, snapshotFileInfo) {
  const { snapshot } = await readSnapshot(request, snapshotFileInfo);
  if (snapshot) {
    return sendResponse(controller, snapshot);
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
process.on('beforeExit', async () => {
  if (SNAPSHOT === 'read' && !beforeExitEventSeen && snapshotDirectory !== null) {
    beforeExitEventSeen = true;
    const dir = /** @type {string} */(snapshotDirectory);
    const unusedFiles = (await readExistingSnapshotFilesList(dir))
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
function attachSnapshotIgnoreRules(func) {
  snapshotIgnoreRules = func;
}

/** Reset snapshot ignore rules to default (no requests ignored) */
function resetSnapshotIgnoreRules() {
  snapshotIgnoreRules = defaultSnapshotIgnoreRules;
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

  const cache = /** @type {WeakMap<Request, SnapshotFileInfo>} */ (new WeakMap());
  const ignoredRequests = /** @type {WeakSet<Request>} */ (new WeakSet());

  //@ts-ignore
  interceptor.on('request', async ({ request, controller }) => {
    // Check if request should be ignored from snapshotting using ignore rules
    const shouldIgnoreSnapshot = snapshotIgnoreRules(request);
    
    // Track ignored requests
    if (shouldIgnoreSnapshot) {
      ignoredRequests.add(request);
      
      // In read mode, we should not allow ignored requests to make real network calls
      if (SNAPSHOT === 'read') {
        console.error(
          `${colors.red}Request ignored by snapshot ignore rules but SNAPSHOT=read mode doesn't allow real network requests:${colors.reset}`,
          {
            request: {
              url: request.url,
              method: request.method,
              headers: Object.fromEntries([...request.headers.entries()]),
              body: await request.clone().text(),
            }
          }
        );
        throw new Error('Request ignored by snapshot ignore rules but SNAPSHOT=read mode doesn\'t allow real network requests');
      }
    }
    
    if (['read', 'append'].includes(SNAPSHOT) && !shouldIgnoreSnapshot) {
      const snapshotFileInfo = await getSnapshotFileInfo(request);
      cache.set(request, snapshotFileInfo);
      await readSnapshotAndSendResponse(request, controller, snapshotFileInfo);
    }
  });
  interceptor.on(
    //@ts-ignore
    'response',
    /** @type {(params: { request: Request, response: Response }) => Promise<void>} */
    async ({ request, response }) => {
      // Check if this request was marked to ignore snapshots
      const shouldIgnoreSnapshot = ignoredRequests.has(request);
      
      const snapshotFileInfo = cache.get(request) || (await getSnapshotFileInfo(request));
      cache.delete(request);
      
      const {
        // absoluteFilePath,
        fileName,
        fileSuffixKey,
      } = snapshotFileInfo;
      if (LOG_REQ) {
        const summary = `----------\n${request.method} ${request.url}\n${
          shouldIgnoreSnapshot
            ? 'ignored from snapshotting by ignore rules'
            : `Would use file name: ${fileName}`
        }`;
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
      if (!shouldIgnoreSnapshot && (SNAPSHOT === 'update' || (SNAPSHOT === 'append' && !readFiles.has(fileName)))) {
        if (!dirCreatePromise) {
          dirCreatePromise = fs.mkdir( /** @type {string} */(snapshotDirectory), { recursive: true });
        }
        await dirCreatePromise;
        await saveSnapshot(request, response, snapshotFileInfo);
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
  defaultSnapshotIgnoreRules,
  attachSnapshotIgnoreRules,
  resetSnapshotIgnoreRules,
  start,
  stop,
};
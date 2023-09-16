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
import { BatchInterceptor } from '@mswjs/interceptors'
import { ClientRequestInterceptor } from '@mswjs/interceptors/ClientRequest';
import { FetchInterceptor } from '@mswjs/interceptors/fetch';
import slugify from '@sindresorhus/slugify';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Environment variable SNAPSHOT = update / ignore / read (default)
const SNAPSHOT = process.env.SNAPSHOT || 'read';
const LOG_REQ = process.env.LOG_REQ === '1' || process.env.LOG_REQ === 'true';
const defaultSnapshotDirectory = resolve(__dirname, 'http-snapshots');
const unusedSnapshotsLogFile = 'unused-snapshots.log';
let snapshotDirectory = defaultSnapshotDirectory;

/**
 * @typedef SnapshotText
 * @property {'text'} responseType
 * @property {string} fileSuffixKey
 * @property {object} request
 * @property {string} request.method
 * @property {string} request.url
 * @property {string[][]} request.headers
 * @property {string|undefined} request.body
 * @property {object} response
 * @property {number} response.status
 * @property {string} response.statusText
 * @property {string[][]} response.headers
 * @property {string|undefined} response.body
 */
/**
 * @typedef SnapshotJson
 * @property {'json'} responseType
 * @property {string} fileSuffixKey
 * @property {object} request
 * @property {string} request.method
 * @property {string} request.url
 * @property {string[][]} request.headers
 * @property {string|undefined} request.body
 * @property {object} response
 * @property {number} response.status
 * @property {string} response.statusText
 * @property {string[][]} response.headers
 * @property {object|undefined} response.body
 */

/**
 * @typedef {SnapshotText | SnapshotJson} Snapshot
 */

const identity = (response) => response;

const defaultKeyDerivationProps = ['method', 'url', 'body'];
async function defaultSnapshotFileNameGenerator(request) {
  let filePrefix;

  const url = new URL(request.url);
  if (url.hostname === 'dynamodb.eu-west-1.amazonaws.com') {
    filePrefix = [
      'dynamodb',
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
    absoluteFilePath: resolve(snapshotDirectory, fileName),
    fileName,
    filePrefix,
    fileSuffixKey,
  };
}

// NOTE: This isn't going to work on a test runner that uses multiple processes / workers
const alreadyWrittenFiles = new Set();
const readFiles = new Set();

/**
 * @param {Request} request
 * @param {Response} response
 */
async function saveSnapshot(request, response) {
  const { absoluteFilePath, fileName, fileSuffixKey } = await getSnapshotFileName(request);
  // console.log(fileName);

  // Prevent multiple tests from having same snapshot
  if (alreadyWrittenFiles.has(absoluteFilePath)) return fileName;
  alreadyWrittenFiles.add(absoluteFilePath);

  let body;
  /** @type {'text' | 'json'} */
  let responseType;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json') || contentType.includes('application/x-amz-json-1.0')) {
    responseType = 'json';
    body = await response.clone().json();
  } else {
    responseType = 'text';
    body = await response.clone().text();
  }
  /** @type {Snapshot} */
  const snapshot = {
    request: {
      method: request.method,
      url: request.url,
      headers: [...request.headers.entries()],
      body: await request.clone().text(),
    },
    responseType,
    response: {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers.entries()],
      body,
    },
    fileSuffixKey,
  };
  const json = JSON.stringify(snapshot, null, 2);
  await fs.writeFile(absoluteFilePath, json, 'utf-8');
  return fileName;
}

const snapshotCache = {};
/**
 * @param {Request} request
 */
async function enforceSnapshotResponse(request) {
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
      }
      return null;
    }
    snapshotCache[absoluteFilePath] = JSON.parse(json);
    readFiles.add(fileName);
  }

  const snapshot = snapshotCache[absoluteFilePath];
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
    responseType === 'json' ? JSON.stringify(body) : body,
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
 * @type {import('@mswjs/interceptors').BatchInterceptor|null}
 */
let interceptor = null;

let beforeExitEventSeen = false;
let unusedFiles;
process.on('beforeExit', async () => {
  if (SNAPSHOT === 'read' && !beforeExitEventSeen) {
    beforeExitEventSeen = true;
    let files;
    try {
      files = await fs.readdir(snapshotDirectory);
    } catch (err) {
      return;
    }
    unusedFiles = files.filter((file) => !readFiles.has(file) && file !== unusedSnapshotsLogFile);
    if (unusedFiles.length) {
      await fs
        .writeFile(
          resolve(snapshotDirectory, unusedSnapshotsLogFile),
          unusedFiles.join('\n'),
          'utf-8',
        )
        .catch((err) => console.error(err));
    } else {
      await fs
        .unlink(resolve(snapshotDirectory, unusedSnapshotsLogFile))
        .catch((err) => {
          if (err.code !== 'ENOENT') {
            console.error(err);
          }
        });
    }
  }
});

// Attach snapshot filename generator function
function attachSnapshotFilenameGenerator(func) {
  snapshotFileNameGenerator = func;
}

// Reset snapshot filename generator to default
function resetSnapshotFilenameGenerator() {
  snapshotFileNameGenerator = defaultSnapshotFileNameGenerator;
}

// Attach response transformer function
function attachResponseTransformer(func) {
  responseTransformer = func;
}

// Remove response transformer
function removeResponseTransformer() {
  responseTransformer = identity;
}

// Start the interceptor
function start({
  snapshotDirectory: _snapshotDirectory = defaultSnapshotDirectory,
} = { snapshotDirectory: defaultSnapshotDirectory }) {
  snapshotDirectory = _snapshotDirectory;
  let dirCreatePromise;

  interceptor = new BatchInterceptor({
    name: 'http-snapshotter-interceptor',
    interceptors: [
      new ClientRequestInterceptor(),
      new FetchInterceptor(),
    ],
  });

  interceptor.on('request', async ({ request }) => {
    if (SNAPSHOT === 'read') {
      await enforceSnapshotResponse(request);
    }
  });
  interceptor.on('response', async ({ request, response }) => {
    if (SNAPSHOT === 'update') {
      if (!dirCreatePromise) {
        dirCreatePromise = fs.mkdir(snapshotDirectory, { recursive: true });
      }
      await dirCreatePromise;
      saveSnapshot(request, response);
    }
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
  });
  interceptor.apply();
}

// Stop the interceptor
function stop() {
  if (interceptor) {
    interceptor.dispose();
    interceptor = null;
  }
}

// Singleton - as it makes sense only one interceptor be active at any given moment.
export {
  defaultSnapshotFileNameGenerator,
  snapshotFileNameGenerator,
  attachSnapshotFilenameGenerator,
  resetSnapshotFilenameGenerator,
  attachResponseTransformer,
  removeResponseTransformer,
  start,
  stop,
};
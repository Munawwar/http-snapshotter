# HTTP Snapshotter

Take snapshots of HTTP requests for purpose of tests (on node.js).

Use-case: Let's say you are testing a server end-point, that makes several external network requests before giving a response. In a unit test you would want any external network call to be stubbed/mocked. What one wants is to test the end-point for a fixed input and fixed responses of external network calls. Stubs take quite a while to write, rather create snapshots of the requests automatically by HTTP Snapshotter and only write test code for the end-point input and output.

WARNING: This module isn't concurrent or thread safe yet. You can only use it on serial test runners like `tape`.

Example (test.js):

```js
import test from "tape";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { start } from "http-snapshotter";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const snapshotDirectory = resolve(__dirname, "http-snapshots");

start({ snapshotDirectory });

test("Latest XKCD comic (ESM)", async (t) => {
  const res = await fetch("https://xkcd.com/info.0.json");
  const json = await res.json();

  t.deepEquals(json.title, "Iceberg Efficiency", "must be equal");
});
```


To create snapshots the first time run:
```sh
SNAPSHOT=update node test.js
```

You will see a file named `get-xkcd-com-info-0-arAlFb5gfcr9aCN.json` created in the `http-snapshots` directory. Commit this directory to source control.

Then onwards running: `node test.js` or `SNAPSHOT=read node test.js` will ensure HTTP network calls are all read from a snapshot file.
In this mode, http-snapshotter will prevent any real HTTP calls from happening by failing the test (if it didn't have a snapshot file) and print out the request details and the snapshot file name it should have had.

There is also a `SNAPSHOT=ignore` option to neither read nor write from snapshot files and do real network requests instead. This could be useful while writing a new test.

Tip: When you do `SNAPSHOT=update` to create snapshots, run it against a single test, so you know what exact snapshots that one test created.

Finally after getting all your tests to use snapshots, run your test runner against all your tests and then take a look at `<snapshots directory>/unused-snapshots.log` file to see which snapshot files haven't been used by your final test suite. You can delete unused snapshot files.

## About snapshot files and its names

A snapshot file name unique identifies a request. By default it is a combination of HTTP method + URL + body that makes a request unique.
The hash of concatenated HTTP method + URL + body makes the file name suffix.

However you may want to specially handle some requests. e.g. DynamoDB calls also need the `x-amz-target` header to uniquely identify the request,
because every call is a POST call with DynamoDB. You can add logic to create better snapshot files for this case:

```js
import {
  start,
  defaultSnapshotFileNameGenerator,
  attachSnapshotFilenameGenerator
} from "http-snapshotter";
const slugify = require('@sindresorhus/slugify');

/**
 * @param {Request} request https://developer.mozilla.org/en-US/docs/Web/API/Request
 */
async function mySnapshotFilenameGenerator(request) {
  const url = new URL(request.url);
  if (!url.hostname.startsWith('dynamodb.') || !url.hostname.endsWith('.amazonaws.com')) {
    return defaultSnapshotFileNameGenerator(request);
  }

  // Make a more readable file name suffix
  let filePrefix;
  const xAmzHeader = request.headers?.get?.('x-amz-target')?.split?.('.')?.pop?.() || '';
  filePrefix = [
    'dynamodb',
    slugify(xAmzHeader),
    slugify(JSON.parse(await request.clone().text())?.TableName),
  ].filter(Boolean).join('-');

  // Input data
  const dataList = await Promise.all(
    ['url', 'body'].map((key) => {
      if (key === 'body') {
        return request.clone().text();
      }
      return request[key];
    }),
  );

  return {
    filePrefix,
    fileSuffixKey: `${xAmzHeader}#${dataList.join('#')}`,
  };
}

attachSnapshotFilenameGenerator(mySnapshotFilenameGenerator);
```

## Same request, varied response

There are scenarios where one needs to test varied response for the same call (.e.g GET /account).

There are 2 ways to go about this.

Method 1: The easy way it to not touch the existing snapshot file, and use `attachResponseTransformer` to
change the response on runtime for the specific test:

```js
import {
  // ...
  attachResponseTransformer,
  resetResponseTransformer,
} from "http-snapshotter";

test('Test behavior on a free account', async (t) => {
  /**
   * @param {Response} response https://developer.mozilla.org/en-US/docs/Web/API/Response
   * @param {Request} request https://developer.mozilla.org/en-US/docs/Web/API/Request
   */
  const interceptResponse = async (response, request) => {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/account') {
      return new Response(
        JSON.stringify({
          ...(await response.clone().json()),
          free_user: true,
        }),
        {
          headers: response.headers
        }
      )
    }
    // 
    return response;
  };
  attachResponseTransformer(interceptResponse);

  // make fetch() call here
  // assert the test

  // cleanup before moving to next test
  resetResponseTransformer();
});
```

Method 2: Add a filename suffix for the specific test you are running and manually edit the new snapshot file (it is a regular JSON file)

(building on the last attachSnapshotFilenameGenerator snippet)

```js
test('Test behavior on a free account', async (t) => {
  attachSnapshotFilenameGenerator(async (request) => {
    const defaultReturn = mySnapshotFilenameGenerator();

    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/account') {
      return {
        filePrefix: `free-account-test-${defaultReturn.filePrefix}`,
        fileSuffixKey: defaultReturn.fileSuffixKey,
      };
    }

    return defaultReturn;
  });

  // make fetch() call here
  // assert the test

  // cleanup before moving to next test
  attachSnapshotFilenameGenerator(mySnapshotFilenameGenerator);
});
```

Now when you run `SNAPHOT=update node specific-test.js` you will get a snapshot file with `free-account-test-` as prefix. You can now edit the JSON response for this test.

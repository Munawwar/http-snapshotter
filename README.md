# HTTP Snapshotter

Take snapshots of HTTP requests for purpose of tests.

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

await start({ snapshotDirectory });

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

You will see a file named `get-xkcd-com-info-0-arAlFb5gfcr9aCN.json` created in the `http-snapshots` directory.

e.g.

Then onwards running: `node test.js` or `SNAPSHOT=read node test.js` will ensure HTTP network calls are all read from a snapshot file.
It will prevent any real HTTP calls from happening by failing the test (if it didn't have a snapshot file).

## About snapshot files and its name

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

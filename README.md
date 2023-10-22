# HTTP Snapshotter

Take snapshots of HTTP requests for purpose of tests (on node.js).

Use-case: Let's say you are testing a server end-point, that makes several external HTTP requests for producing a response. In a unit test you would want predictable inputs for any external network calls.

To have predictable inputs to external requests there are 2 popular approaches:
1. Mock / Stub the methods that make the network requests with a library like `sinon.js`
2. Use a mock service.

However stubs / fakes take quite a while to write. And a mock service is an additional piece to deploy and maintain. 

Presenting you another solution:
3. Create snapshots of the requests automatically the first time you run your test and then replay the snapshot responses on future runs of the test.
Additionally with the approach, with predictability and speed in mind, one wouldn't want any real network request from being made; and if it does happen, then the test should fail.

WARNING: This module isn't concurrent or thread safe yet. You can only use it on serial test runners like `tape`. If you use `ava`, you need to convert tests to run serially with `test.serial()`.

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

Tip: When you do `SNAPSHOT=update` to create snapshots, run it against a single test, so you know what exact snapshots that one test created/updated.

Once you are done writing your tests, run your test runner on all your tests and then take a look at `<snapshots directory>/unused-snapshots.log` file to see which snapshot files haven't been used by your final test suite. You can delete unused snapshot files.

The tests of this library uses this library itself, check the `tests/` directory and try the tests `npm ci; npm test`.

## About snapshot files and its names

A snapshot file name uniquely identifies a request. By default it is a combination of HTTP method + URL + body that makes a request unique (headers are ignored).
For example, take the filename `get-xkcd-com-info-0-arAlFb5gfcr9aCN.json` - The prefix `get-xkcd-com-info-0` is added just for readability, and the suffix `arAlFb5gfcr9aCN` is a SHA256 hash of concatenated HTTP method + URL + body string that makes the file name unique.

However you may want to specially handle some requests. e.g. DynamoDB calls also need the `x-amz-target` header to uniquely identify the request,
because the header affects the response data. You can add logic to create better snapshot files for this case:

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

  // Use a snapshot file name like `dynamodb-get-item-table-name-sezQSulkfiNCk30.json`

  // Make a more readable file name prefix (.e.g `dynamodb-get-item-table-name`)
  const xAmzHeader = request.headers?.get('x-amz-target')?.split('.').pop() || '';
  const filePrefix = [
    'dynamodb',
    slugify(xAmzHeader),
    slugify((await request.clone().json())?.TableName),
  ].filter(Boolean).join('-');

  // Make a unique suffix for this request
  const fileSuffixKey = [
    'dynamodb',
    request.url,
    xAmzHeader,
    await request.clone().text(),
  ].join('#');

  return {
    filePrefix,
    // this key will be hashed with SHA256 to make the final file suffix
    fileSuffixKey,
  };
}

attachSnapshotFilenameGenerator(mySnapshotFilenameGenerator);
```

## Same request, varied response

There are scenarios where one needs to test varied response for the same call (e.g GET /account).

There are 2 ways to go about this:

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
 
    return response;
  };
  attachResponseTransformer(interceptResponse);

  // make fetch() call here
  // assert the test

  // cleanup before moving to next test
  resetResponseTransformer();
});
```

Method 2: By creating a new snapshot file, by adding a unique filename suffix for the specific test you are running.
And then manually editing the new snapshot file (it is a regular JSON file).

(building upon the last attachSnapshotFilenameGenerator snippet)
```js
// test2.js
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

  // reset back to old function before moving to next test
  attachSnapshotFilenameGenerator(mySnapshotFilenameGenerator);
  // You could alternatively `import { resetSnapshotFilenameGenerator } from "http-snapshotter"` and call
  // resetSnapshotFilenameGenerator()
});
```

Now when you run `SNAPHOT=update node test2.js` you will get a snapshot file with `free-account-test-` as prefix. You can now edit the JSON response for this test.

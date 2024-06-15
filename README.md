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

Example (test.js):

```js
import test from "tape";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { start } from "http-snapshotter";

const __dirname = dirname(fileURLToPath(import.meta.url));
start({ snapshotDirectory: resolve(__dirname, "http-snapshots") });

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

For adding new snapshots without touching existing snapshots use `SNAPSHOT=append`. There is also a `SNAPSHOT=ignore` option to neither read nor write from snapshot files and do real network requests instead. These could be useful while writing a new test.

Tip: When you do `SNAPSHOT=update` or `SNAPHOT=append` to create snapshots, run it against a single test, so you know what exact snapshots that one test created/updated.

Log read/saved snapshots by setting LOG_SNAPSHOT=1 or LOG_SNAPSHOT=summary env variable. It prints the HTTP method, url and snapshot file that it would use. If you want even more details in the logs use LOG_REQ=detailed.

Once you are done writing your tests, run your test runner on all your tests and then take a look at `<snapshots directory>/unused-snapshots.log` file to see which snapshot files haven't been used by your final test suite. You can delete unused snapshot files.

The tests of this library uses this library itself, check the `tests/` directory and try the tests `npm ci; npm test`.

## About snapshot files and its names

A snapshot file name uniquely identifies a request. By default it is a combination of HTTP method + URL + body that makes a request unique (headers are ignored).
For example, take the filename `get-xkcd-com-info-0-arAlFb5gfcr9aCN.json` - The prefix `get-xkcd-com-info-0` is added just for readability, and the suffix `arAlFb5gfcr9aCN` is a SHA256 hash of concatenated HTTP method + URL + body of request that makes the file name unique.

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

Method 1: The easy way is to [intercept the function](https://gist.github.com/Munawwar/c1d024d20b78f19b3714ab09b62a0e1f) with your other test utilities:

```js
// setupIntercepts.js
// Using intercept.js (https://gist.github.com/Munawwar/c1d024d20b78f19b3714ab09b62a0e1f)
// Write all your intercepts in a single file for all tests.
// This is safe because the default behavior of an intercept is
// to call the original function.
import { intercept } from "./intercept.js";
import methods from './account.js';
// intercept the get() method
export const accountGet = intercept(methods, 'get');

// test.js
import { accountGet } from './setupIntercepts.js';
// Next import the root function that you want to test, which
// internally calls get() function from './account.js'
import { enablePaidFeature } from './routes.js';

test('Test behavior on a free account', async (t) => {
  // Setup mock to simulate a free user
  accountGet.mock(async (originalAccountGetFunction, ...args) => {
    const result = await originalAccountGetFunction(...args); // this will use the existing http snapshot
    return {
      ...result,
      free_user: true,
    };
  });

  // write the test here
  // t.assert(await enablePaidFeature(), { error: 'Free accounts do not have access to this paid feature' })

  // cleanup before moving to next test by calling undoMock()
  // This won't destroy the intercept, but will revert the account get()
  // function to call the original account get() function
  accountGet.undoMock();
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

## Concurrency

WARNING: This module isn't concurrent or thread safe. Make sure that:

1. within one worker only one test is being executed at a time. e.g. If you use `ava`, and you have multiple `test()` blocks in one file, you need to change it to run serially with `test.serial()`.

2. parallel tests don't update the same snapshot file at the same time (i.e. while you run with SNAPSHOT=update). Regardless, updating snapshots of multiple tests at the same time is not a great idea in my opinion, because reviewing the snapshots files are a pain, escpecially if you have a shared snapshot files.

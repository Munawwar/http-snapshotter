const test = require("tape");
const { defaultSnapshotFileNameGenerator } = require("../index.js");

test("Stable JSON body key derivation", async (t) => {
  // Two JSON bodies with same data but different key order
  const body1 = JSON.stringify({ a: 1, b: 2, c: 3 });
  const body2 = JSON.stringify({ c: 3, a: 1, b: 2 });

  const request1 = new Request("https://example.com/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body1,
  });

  const request2 = new Request("https://example.com/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body2,
  });

  const result1 = await defaultSnapshotFileNameGenerator(request1);
  const result2 = await defaultSnapshotFileNameGenerator(request2);

  t.equal(
    result1.fileSuffixKey,
    result2.fileSuffixKey,
    "JSON bodies with different key order should produce same fileSuffixKey"
  );

  t.end();
});

test("Stable JSON body with nested objects", async (t) => {
  const body1 = JSON.stringify({ outer: { a: 1, b: 2 }, z: "last" });
  const body2 = JSON.stringify({ z: "last", outer: { b: 2, a: 1 } });

  const request1 = new Request("https://example.com/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body1,
  });

  const request2 = new Request("https://example.com/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body2,
  });

  const result1 = await defaultSnapshotFileNameGenerator(request1);
  const result2 = await defaultSnapshotFileNameGenerator(request2);

  t.equal(
    result1.fileSuffixKey,
    result2.fileSuffixKey,
    "Nested JSON objects with different key order should produce same fileSuffixKey"
  );

  t.end();
});

test("Non-JSON body remains unchanged", async (t) => {
  const body = "plain text body";

  const request = new Request("https://example.com/api", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: body,
  });

  const result = await defaultSnapshotFileNameGenerator(request);

  t.ok(
    result.fileSuffixKey.includes(body),
    "Non-JSON body should be used as-is in fileSuffixKey"
  );

  t.end();
});

test("DynamoDB regional and account endpoints normalize to same key", async (t) => {
  const body = JSON.stringify({
    TableName: "DEV_ClientIDAccess",
    Key: { clientId: { S: "some-random-client-id" } },
    ConsistentRead: true,
  });

  const request1 = new Request("https://dynamodb.eu-west-1.amazonaws.com/", {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.0",
      "x-amz-target": "DynamoDB_20120810.GetItem",
    },
    body,
  });

  const request2 = new Request("https://123456789012.dynamodb.eu-west-1.amazonaws.com/", {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.0",
      "x-amz-target": "DynamoDB_20120810.GetItem",
    },
    body,
  });

  const result1 = await defaultSnapshotFileNameGenerator(request1);
  const result2 = await defaultSnapshotFileNameGenerator(request2);

  t.equal(
    result1.fileSuffixKey,
    result2.fileSuffixKey,
    "DynamoDB endpoint variants should derive same fileSuffixKey"
  );

  t.end();
});

test("Legacy ddb endpoint normalizes to regional DynamoDB key", async (t) => {
  const body = JSON.stringify({
    TableName: "DEV_ClientIDAccess",
    Key: { clientId: { S: "some-random-client-id" } },
    ConsistentRead: true,
  });

  const request1 = new Request("https://dynamodb.eu-west-1.amazonaws.com/", {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.0",
      "x-amz-target": "DynamoDB_20120810.GetItem",
    },
    body,
  });

  const request2 = new Request("https://123456789012.ddb.eu-west-1.amazonaws.com/", {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.0",
      "x-amz-target": "DynamoDB_20120810.GetItem",
    },
    body,
  });

  const result1 = await defaultSnapshotFileNameGenerator(request1);
  const result2 = await defaultSnapshotFileNameGenerator(request2);

  t.equal(
    result1.fileSuffixKey,
    result2.fileSuffixKey,
    "Legacy ddb endpoint should map to same fileSuffixKey"
  );

  t.end();
});

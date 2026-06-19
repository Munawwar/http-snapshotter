const test = require("tape");
const { mkdtempSync, readdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { resolve } = require("node:path");
const { execFileSync } = require("node:child_process");

test("passthrough requests in SNAPSHOT=read use the real network", async (t) => {
  const snapshotDirectory = mkdtempSync(`${tmpdir()}/http-snapshotter-passthrough-`);
  const script = `
    const http = require("node:http");
    const {
      start,
      stop,
      attachSnapshotPassthroughRules,
    } = require(${JSON.stringify(resolve(__dirname, "../index.js"))});

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      start({ snapshotDirectory: ${JSON.stringify(snapshotDirectory)} });
      attachSnapshotPassthroughRules((request) => {
        const url = new URL(request.url);
        return url.hostname === "127.0.0.1" && url.port === String(port);
      });

      http.get(\`http://127.0.0.1:\${port}/health\`, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          console.log("STATUS", response.statusCode);
          console.log("BODY", body);
          stop();
          server.close(() => process.exit(0));
        });
      }).on("error", (error) => {
        console.log("ERROR", error && error.message ? error.message : String(error));
        stop();
        server.close(() => process.exit(1));
      });
    });
  `;

  const output = execFileSync(process.execPath, ["-e", script], {
    env: {
      ...process.env,
      SNAPSHOT: "read",
    },
    encoding: "utf8",
  });

  t.ok(output.includes("STATUS 200"), output);
  t.ok(output.includes('BODY {"ok":true}'), output);
  t.notOk(output.includes("ERROR"), output);
  t.deepEqual(readdirSync(snapshotDirectory), [], "should not create snapshot files");
  t.end();
});

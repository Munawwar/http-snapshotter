const { resolve } = require("node:path");
const { start } = require("../index.js");

start({ snapshotDirectory: resolve(__dirname, "http-snapshots") });

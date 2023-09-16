const test = require("tape");
const { resolve } = require("node:path");

const { start } = require("../index.js");

const snapshotDirectory = resolve(__dirname, "http-snapshots");

start({ snapshotDirectory });

test("Latest XKCD comic (CJS)", async (t) => {
  const res = await fetch("https://xkcd.com/info.0.json");
  const json = await res.json();

  t.deepEquals(
    json,
    {
      month: "9",
      num: 2829,
      link: "",
      year: "2023",
      news: "",
      safe_title: "Iceberg Efficiency",
      transcript: "",
      alt: "Our experimental aerogel iceberg with helium pockets manages true 100% efficiency, barely touching the water, and it can even lift off of the surface and fly to more efficiently pursue fleeing hubristic liners.",
      img: "https://imgs.xkcd.com/comics/iceberg_efficiency.png",
      title: "Iceberg Efficiency",
      day: "15",
    },
    "must be deeply equal"
  );
});
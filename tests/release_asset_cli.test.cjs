"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

test("release asset CLI rejects caller-selected filesystem roots", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resume-release-assets-"));
  try {
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    Buffer.from("IHDR", "ascii").copy(png, 12);
    png.writeUInt32BE(1, 16);
    png.writeUInt32BE(1, 20);
    fs.writeFileSync(path.join(fixtureRoot, "outside.png"), png);

    const result = spawnSync(
      process.execPath,
      [path.resolve(__dirname, "../mobile/scripts/verify-release-assets.mjs"), fixtureRoot],
      { encoding: "utf8" },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not accept filesystem paths/i);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

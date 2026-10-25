import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createListingFixtures,
  listingExpectedMembers,
  listingFixtureContent,
} from "./support/listing-fixtures.js";

test("listing fixtures expose authored expected members for every container family", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-listing-fixtures-"));
  try {
    const fixtures = await createListingFixtures(root);
    assert.deepEqual(fixtures.expectedMembers, listingExpectedMembers);
    assert.equal(fixtures.expectedMemberCount, 2);
    assert.equal(await readFile(path.join(fixtures.sourceDirectory, "project.godot"), "utf8"), listingFixtureContent.project);
    assert.equal(await readFile(path.join(fixtures.sourceDirectory, "hello 空间.txt"), "utf8"), listingFixtureContent.text);
    assert.equal((await readFile(fixtures.zip)).readUInt32LE(0), 0x04034b50);
    assert.equal((await readFile(fixtures.apk)).readUInt32LE(0), 0x04034b50);
    assert.equal((await readFile(fixtures.xapk)).readUInt32LE(0), 0x04034b50);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

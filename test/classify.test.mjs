import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPreviewFiles } from "../scripts/classify-preview-deploy.mjs";

test("application-only changes get a fast preview", () => {
  assert.equal(classifyPreviewFiles(["src/app/page.tsx", "docs/guide.md"]).mode, "fast");
});

test("infrastructure changes need a full preview", () => {
  const result = classifyPreviewFiles(["Dockerfile"]);
  assert.deepEqual([result.mode, result.requiresFull], ["both", true]);
});

test("dependency changes rebuild without a full preview", () => {
  const result = classifyPreviewFiles(["package-lock.json"]);
  assert.deepEqual([result.mode, result.requiresFull], ["both", false]);
});

test("migrations are flagged", () => {
  assert.equal(classifyPreviewFiles(["migrations/001.sql"]).runMigrations, true);
});

test("the full-preview label forces a full preview", () => {
  assert.equal(classifyPreviewFiles(["src/a.ts"], ["full-preview"]).requiresFull, true);
});

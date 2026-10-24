import { test } from "node:test";
import assert from "node:assert/strict";
import { detectStack } from "../scripts/detect.mjs";

const detect = (files) =>
  detectStack(
    async (path) => files[path] ?? null,
    async () => [...new Set(Object.keys(files).map((path) => path.split("/")[0]))],
  );
const pkg = (value) => JSON.stringify(value);

test("Dockerfile means container", async () => {
  const stack = await detect({ Dockerfile: "FROM node:22", "package.json": pkg({ dependencies: { next: "16.0.0" } }) });
  assert.equal(stack.type, "container");
  assert.equal(stack.framework, "Next.js (Docker)");
});

test("Next.js static export is static and builds to out", async () => {
  const stack = await detect({ "package.json": pkg({ dependencies: { next: "16.0.0" } }), "next.config.ts": 'export default { output: "export" };' });
  assert.deepEqual([stack.type, stack.buildDir], ["static", "out"]);
});

test("a static catalog workspace builds to catalog/out", async () => {
  const stack = await detect({ "package.json": pkg({}), "catalog/next.config.ts": 'export default { output: "export" };' });
  assert.deepEqual([stack.type, stack.buildDir], ["static", "catalog/out"]);
});

test("Vite SPA is static and builds to dist", async () => {
  const stack = await detect({ "package.json": pkg({ devDependencies: { vite: "7.0.0" } }), "vite.config.ts": "export default {}" });
  assert.deepEqual([stack.type, stack.buildDir], ["static", "dist"]);
});

test("Next.js without export is a container", async () => {
  const stack = await detect({ "package.json": pkg({ dependencies: { next: "16.0.0" } }) });
  assert.equal(stack.type, "container");
});

test("a server framework is a container", async () => {
  const stack = await detect({ "package.json": pkg({ dependencies: { fastify: "5.0.0" } }) });
  assert.deepEqual([stack.type, stack.framework], ["container", "Node.js Service"]);
});

test("extensions, skills and CLIs with a local node script have nothing to deploy", async () => {
  const stack = await detect({
    "package.json": pkg({ bin: { browser: "cli/browser.mjs" }, scripts: { start: "node bridge/server.mjs" }, dependencies: { ws: "8.22.0" } }),
    "extension/manifest.json": pkg({ manifest_version: 3 }),
    "skill/browser-control/SKILL.md": "# Skill",
  });
  assert.deepEqual([stack.type, stack.framework], ["none", "Browser extension + Agent skill + CLI"]);
});

test("markdown-only repos are docs", async () => {
  const stack = await detect({ "README.md": "# Plan" });
  assert.deepEqual([stack.type, stack.framework], ["none", "Docs"]);
});

test(".majapi/ci.json overrides detection", async () => {
  const stack = await detect({ Dockerfile: "FROM node:22", ".majapi/ci.json": pkg({ type: "static", buildDir: "public" }) });
  assert.deepEqual([stack.type, stack.buildDir], ["static", "public"]);
});

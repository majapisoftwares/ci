import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contextFromEnv,
  interpolate,
  pulumiConfigMap,
  pulumiEnv,
  resolveDeep,
} from "../scripts/container/config.mjs";

const vars = { PREVIEW_DOMAIN: "preview.numa.bz", PRODUCTION_DOMAIN: "numa.business", EMPTY: "" };

test("interpolates variables, fallbacks and conditional text", () => {
  assert.equal(interpolate("pr-${ctx.prNumber}.${vars.PREVIEW_DOMAIN}", vars, { prNumber: "7" }), "pr-7.preview.numa.bz");
  assert.equal(interpolate("${vars.AWS_REGION:-sa-east-1}", vars, {}), "sa-east-1");
  assert.equal(interpolate("${vars.EMPTY:-x}", vars, {}), "x");
  assert.equal(interpolate("a${vars.PRODUCTION_DOMAIN:+, }b", vars, {}), "a, b");
  assert.equal(interpolate("a${vars.MISSING:+, }b", vars, {}), "ab");
  assert.equal(interpolate("${vars.MISSING}", vars, {}), "");
});

test("missing context values fail loudly", () => {
  assert.throws(() => interpolate("${ctx.prNumber}", vars, {}), /prNumber/);
});

test("context comes from CTX_ env vars in camelCase", () => {
  assert.deepEqual(contextFromEnv({ CTX_PR_NUMBER: "7", CTX_IMAGE_TAG: "abc", OTHER: "x" }), { prNumber: "7", imageTag: "abc" });
});

test("resolves nested sections", () => {
  assert.deepEqual(resolveDeep({ box: "b-${ctx.stack}", list: ["${vars.PREVIEW_DOMAIN}"] }, vars, { stack: "pr-1" }), {
    box: "b-pr-1",
    list: ["preview.numa.bz"],
  });
});

test("builds a Pulumi config map from shared and per-stack config", () => {
  const config = {
    pulumi: {
      config: { "aws:region": "${vars.AWS_REGION:-sa-east-1}" },
      stacks: { production: { config: { "app:domainName": "${vars.PRODUCTION_DOMAIN}", "app:sha": "${ctx.gitSha}" } } },
    },
  };
  assert.equal(
    pulumiConfigMap(config, "production", vars, { gitSha: "abc" }),
    'aws:region:\n  value: "sa-east-1"\napp:domainName:\n  value: "numa.business"\napp:sha:\n  value: "abc"',
  );
  assert.throws(() => pulumiConfigMap(config, "preview", vars, {}), /pulumi.stacks.preview/);
});

test("maps Pulumi env vars to secrets by name", () => {
  const config = { pulumi: { stacks: { production: { env: { RUNTIME_ENV: "PROD_ENV" } } } } };
  assert.deepEqual(pulumiEnv(config, "production", { PROD_ENV: "x" }), [["RUNTIME_ENV", "x"]]);
  assert.throws(() => pulumiEnv(config, "production", {}), /PROD_ENV/);
});

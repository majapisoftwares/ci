// Resolves the `container` block of .majapi/ci.json for one workflow step.
//
//   node config.mjs values <production|preview>   -> GITHUB_OUTPUT lines
//   node config.mjs pulumi <production|preview|previewShared> -> config_map + env
//
// Strings may reference repository variables and run context:
//   ${vars.NAME}            value of the repository/organization variable
//   ${vars.NAME:-fallback}  fallback when unset or empty
//   ${vars.NAME:+text}      text only when the variable is set
//   ${ctx.NAME}             run context (prNumber, stack, environment, ...)
// VARS_JSON and SECRETS_JSON carry toJson(vars) / toJson(secrets); CTX_* env
// vars carry the context.
import { appendFileSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

export function loadContainerConfig(root = ".") {
  const raw = JSON.parse(readFileSync(resolve(root, ".majapi/ci.json"), "utf8"));
  if (!raw.container) throw new Error(".majapi/ci.json has no `container` block.");
  return raw.container;
}

export function contextFromEnv(env = process.env) {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([key]) => key.startsWith("CTX_"))
      .map(([key, value]) => [
        key.slice(4).toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
        value ?? "",
      ]),
  );
}

export function interpolate(value, vars, ctx) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{(vars|ctx)\.([A-Za-z0-9_]+)(?::([-+])([^}]*))?\}/g, (_, scope, name, op, arg) => {
    const found = (scope === "vars" ? vars : ctx)[name];
    const present = found !== undefined && found !== null && String(found) !== "";
    if (op === "-") return present ? String(found) : arg;
    if (op === "+") return present ? arg : "";
    if (!present && scope === "ctx") throw new Error(`Missing context value: ${name}`);
    return present ? String(found) : "";
  });
}

export function resolveDeep(value, vars, ctx) {
  if (Array.isArray(value)) return value.map((item) => resolveDeep(item, vars, ctx));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveDeep(item, vars, ctx)]),
    );
  }
  return interpolate(value, vars, ctx);
}

const yamlString = (value) => JSON.stringify(String(value));

/** pulumi/actions `config-map` YAML for one stack kind. */
export function pulumiConfigMap(config, kind, vars, ctx) {
  const pulumi = config.pulumi ?? {};
  const stack = pulumi.stacks?.[kind];
  if (!stack) throw new Error(`No pulumi.stacks.${kind} in .majapi/ci.json.`);
  const entries = { ...pulumi.config, ...stack.config };
  return Object.entries(entries)
    .map(([key, value]) => `${key}:\n  value: ${yamlString(interpolate(value, vars, ctx))}`)
    .join("\n");
}

/** Env vars a stack's Pulumi program needs, read from secrets by name. */
export function pulumiEnv(config, kind, secrets) {
  const env = config.pulumi?.stacks?.[kind]?.env ?? {};
  return Object.entries(env).map(([name, secretName]) => {
    if (!(secretName in secrets)) throw new Error(`Secret ${secretName} is not available to this workflow.`);
    return [name, secrets[secretName]];
  });
}

function writeOutput(lines) {
  const target = process.env.GITHUB_OUTPUT;
  const text = `${lines.join("\n")}\n`;
  if (target) appendFileSync(target, text);
  else process.stdout.write(text);
}

function multiline(name, value) {
  const delimiter = `EOF_${randomBytes(8).toString("hex")}`;
  return [`${name}<<${delimiter}`, value, delimiter];
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const [command, kind] = process.argv.slice(2);
  const config = loadContainerConfig();
  const vars = JSON.parse(process.env.VARS_JSON || "{}");
  const ctx = contextFromEnv();

  if (command === "values") {
    const section = resolveDeep(config[kind] ?? {}, vars, ctx);
    const shared = resolveDeep(
      { healthPath: config.healthPath ?? "/", ...config.release },
      vars,
      ctx,
    );
    writeOutput(
      Object.entries({ ...shared, ...section })
        .filter(([, value]) => typeof value !== "object")
        .map(([key, value]) => `${key}=${value}`),
    );
  } else if (command === "pulumi") {
    writeOutput([
      `work_dir=${config.pulumi?.workDir ?? "infra/pulumi"}`,
      `project=${config.pulumi?.project ?? ""}`,
      ...multiline("config_map", pulumiConfigMap(config, kind, vars, ctx)),
    ]);
    // Secrets go to the job environment for the Pulumi program.
    const secrets = JSON.parse(process.env.SECRETS_JSON || "{}");
    const envFile = process.env.GITHUB_ENV;
    for (const [name, value] of pulumiEnv(config, kind, secrets)) {
      const lines = multiline(name, value).join("\n");
      if (envFile) appendFileSync(envFile, `${lines}\n`);
    }
  } else {
    throw new Error("Usage: config.mjs values <kind> | pulumi <stackKind>");
  }
}

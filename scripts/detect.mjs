import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Files the rules read; callers only need to provide these. */
export const DETECTION_FILES = [
  ".majapi/ci.json",
  "package.json",
  "catalog/package.json",
  "Dockerfile",
  "next.config.ts",
  "next.config.js",
  "next.config.mjs",
  "catalog/next.config.ts",
  "vite.config.ts",
  "vite.config.js",
  "manifest.json",
  "extension/manifest.json",
];

const SERVER_FRAMEWORKS = ["express", "fastify", "koa", "hono", "@nestjs/core", "@hapi/hapi"];
const TYPES = ["static", "container", "none"];

const parseJson = (content) => {
  try {
    return content ? JSON.parse(content) : null;
  } catch {
    return null;
  }
};

const isStaticExport = (content) =>
  Boolean(content) && (content.includes('output: "export"') || content.includes("output: 'export'"));

/**
 * Decides how a repository deploys.
 * @param {(path: string) => Promise<string | null>} read returns a file's content, or null when missing.
 * @param {() => Promise<string[]>} listRoot returns the names of the repository's top-level entries.
 * @returns {Promise<{ type: "static" | "container" | "none", framework: string, details: string, buildDir: string }>}
 */
export async function detectStack(read, listRoot) {
  const [files, root] = await Promise.all([
    Promise.all(DETECTION_FILES.map(async (path) => [path, await read(path)])).then(Object.fromEntries),
    listRoot().then((names) => new Set(names)),
  ]);
  const pkg = parseJson(files["package.json"]) ?? parseJson(files["catalog/package.json"]) ?? {};
  const hasPackageJson = files["package.json"] !== null || files["catalog/package.json"] !== null;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const scripts = pkg.scripts ?? {};
  const rootNextConfig = files["next.config.ts"] ?? files["next.config.js"] ?? files["next.config.mjs"];
  const catalogNextConfig = files["catalog/next.config.ts"];
  const hasNextConfig = Boolean(rootNextConfig || catalogNextConfig);

  // An explicit override wins over every rule.
  const override = parseJson(files[".majapi/ci.json"]);
  if (TYPES.includes(override?.type)) {
    return {
      type: override.type,
      framework: "Manual",
      details: ".majapi/ci.json",
      buildDir: override.buildDir ?? (override.type === "static" ? "out" : ""),
    };
  }

  if (files.Dockerfile !== null) {
    return {
      type: "container",
      framework: "next" in deps ? "Next.js (Docker)" : "Docker Container",
      details: "Dockerfile",
      buildDir: "",
    };
  }

  if (isStaticExport(rootNextConfig) || Object.values(scripts).some((script) => script.includes("next export"))) {
    return { type: "static", framework: "Next.js (Static Export)", details: "output: export", buildDir: "out" };
  }
  if (isStaticExport(catalogNextConfig)) {
    return { type: "static", framework: "Next.js (Static Export)", details: "catalog: output: export", buildDir: "catalog/out" };
  }

  const viteConfig = files["vite.config.ts"] ?? files["vite.config.js"];
  if (viteConfig && !deps["@fastify/static"] && !deps.express) {
    return { type: "static", framework: "Vite (SPA)", details: "vite.config", buildDir: "dist" };
  }

  if ("next" in deps || hasNextConfig) {
    return { type: "container", framework: "Next.js (SSR)", details: "next", buildDir: "" };
  }

  // A "node" start script alone doesn't make a deployable server.
  const server = SERVER_FRAMEWORKS.find((name) => name in (pkg.dependencies ?? {}));
  if (server) {
    return { type: "container", framework: "Node.js Service", details: server, buildDir: "" };
  }

  const kinds = [
    [files["manifest.json"], files["extension/manifest.json"]].some((content) => content?.includes('"manifest_version"')) &&
      "Browser extension",
    ["SKILL.md", "skill", "skills"].some((name) => root.has(name)) && "Agent skill",
    (pkg.bin || root.has("cli") || root.has("bin")) && "CLI",
  ].filter(Boolean);
  return {
    type: "none",
    framework: kinds.length ? kinds.join(" + ") : hasPackageJson ? "Library" : "Docs",
    details: "",
    buildDir: "",
  };
}

/** Lists a local checkout's top-level entries. */
export const listDirectory = (root) => () => readdir(root);

/** Reads detection files from a local checkout. */
export const readFromDirectory = (root) => async (path) => {
  try {
    return await readFile(join(root, path), "utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") return null;
    throw error;
  }
};

// No top-level await, so CommonJS loaders (tsx, bundlers) can import this module.
if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const root = process.argv[2] ?? ".";
  detectStack(readFromDirectory(root), listDirectory(root)).then((stack) => {
    // GitHub Actions step output format.
    process.stdout.write(`type=${stack.type}\nframework=${stack.framework}\nbuild_dir=${stack.buildDir}\n`);
  });
}

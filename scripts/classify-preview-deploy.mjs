import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const INFRA_PATTERNS = [
  /^Dockerfile(?:\..+)?$/,
  /^infra\//,
];

const COMPILED_PATTERNS = [
  /^\.github\/workflows\//,
  /^package(?:-lock)?\.json$/,
  /^migrations\//,
  /^next\.config\.[cm]?[jt]s$/,
  /^next-env\.d\.ts$/,
  /^tsconfig(?:\.[^/]+)?\.json$/,
];

const FAST_PATTERNS = [
  /^(app|components|lib|public|src)//,
  /^(docs|tests?|__tests__)//,
  /\.(css|md|mdx|test\.[cm]?[jt]sx?|spec\.[cm]?[jt]sx?)$/,
];

export function classifyPreviewFiles(files, labels = []) {
  const runMigrations = files.some((file) => /^migrations\//.test(file));

  if (labels.includes("full-preview")) {
    return {
      mode: "both",
      reason: "label full-preview",
      requiresFull: true,
      runMigrations,
    };
  }

  const infraFile = files.find((file) =>
    INFRA_PATTERNS.some((pattern) => pattern.test(file)),
  );
  if (infraFile) {
    return {
      mode: "both",
      reason: `infrastructure change: ${infraFile}`,
      requiresFull: true,
      runMigrations,
    };
  }

  const compiledFile = files.find((file) =>
    COMPILED_PATTERNS.some((pattern) => pattern.test(file)),
  );
  if (compiledFile) {
    return {
      mode: "both",
      reason: `compiled runtime change: ${compiledFile}`,
      requiresFull: false,
      runMigrations,
    };
  }

  const unknownFile = files.find(
    (file) => !FAST_PATTERNS.some((pattern) => pattern.test(file)),
  );
  if (unknownFile) {
    return {
      mode: "both",
      reason: `unclassified change: ${unknownFile}`,
      requiresFull: true,
      runMigrations,
    };
  }

  return {
    mode: "fast",
    reason: "application-only changes",
    requiresFull: false,
    runMigrations,
  };
}

function readChangedFiles(baseSha, headSha) {
  const gitExecutable =
    process.platform === "win32"
      ? "C:\\Program Files\\Git\\cmd\\git.exe"
      : "/usr/bin/git";
  return execFileSync(gitExecutable, ["diff", "--name-only", `${baseSha}...${headSha}`], {
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean);
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const baseSha = process.env.PREVIEW_BASE_SHA?.trim();
  const headSha = process.env.PREVIEW_HEAD_SHA?.trim();
  const labels = JSON.parse(process.env.PREVIEW_LABELS_JSON || "[]");
  if (!baseSha || !headSha) {
    throw new Error("PREVIEW_BASE_SHA and PREVIEW_HEAD_SHA are required.");
  }

  const files = readChangedFiles(baseSha, headSha);
  const result = classifyPreviewFiles(files, labels);
  process.stdout.write(JSON.stringify({ ...result, files }));
}

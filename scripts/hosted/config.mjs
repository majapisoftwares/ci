// Prints the hosted target's settings from .majapi/ci.json as GITHUB_OUTPUT lines:
//   { "hosted": { "app", "domain", "cloudUrl"?, "envSecret"?, "buildCommand"?, "healthPath"? } }
import { readFileSync } from "node:fs";

const { hosted } = JSON.parse(readFileSync(".majapi/ci.json", "utf8"));
const values = {
  app: hosted?.app,
  domain: hosted?.domain,
  cloudUrl: hosted?.cloudUrl || "https://cloud.majapi.com",
  envSecret: hosted?.envSecret || "",
  buildCommand: hosted?.buildCommand || "npm run build",
  healthPath: hosted?.healthPath || "/",
};
for (const key of ["app", "domain"]) if (!values[key]) throw new Error(`hosted.${key} is required in .majapi/ci.json`);
for (const [key, value] of Object.entries(values)) console.log(`${key}=${value}`);

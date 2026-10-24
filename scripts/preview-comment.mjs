// Keeps one preview comment per PR up to date: node preview-comment.mjs <building|ready|failed|removed> <url>
// Needs GH_TOKEN, GITHUB_REPOSITORY, PR_NUMBER and GITHUB_RUN_ID/GITHUB_SERVER_URL (set by Actions).
import { execFileSync } from "node:child_process";

const MARKER = "<!-- majapi-preview -->";
const [state, url] = process.argv.slice(2);
const { GITHUB_REPOSITORY: repo, PR_NUMBER: pr, GITHUB_SERVER_URL: server, GITHUB_RUN_ID: runId } = process.env;
const run = `${server}/${repo}/actions/runs/${runId}`;

const lines = {
  building: `⏳ Gerando preview… ([execução](${run}))`,
  ready: `✅ Preview: **${url}**`,
  failed: `❌ O preview falhou. ([execução](${run}))`,
  removed: "🧹 Preview removido.",
};
if (!(state in lines)) throw new Error(`Unknown state: ${state}`);

const body = `${MARKER}\n### Majapi Preview\n\n${lines[state]}`;
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" });

const existing = JSON.parse(gh("api", `repos/${repo}/issues/${pr}/comments`, "--paginate", "--slurp"))
  .flat()
  .find((comment) => comment.body?.startsWith(MARKER));

if (existing) gh("api", "-X", "PATCH", `repos/${repo}/issues/comments/${existing.id}`, "-f", `body=${body}`);
else gh("api", "-X", "POST", `repos/${repo}/issues/${pr}/comments`, "-f", `body=${body}`);

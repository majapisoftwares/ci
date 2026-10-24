# Majapi CI

One reusable GitHub Actions workflow for every Majapi repository. It detects the app type on each run and takes the matching path:

| Detected | Preview (PR) | Production (push to default branch) |
| --- | --- | --- |
| `static`: Next.js `output: export`, Vite SPA | `https://pr-<n>-<repo>.preview.majapi.com`, commented on the PR, removed when the PR closes | S3 sync + CloudFront invalidation |
| `container`: Dockerfile, Next.js SSR, server framework | On the shared preview box (fast, compiled or full), commented on the PR | Compiled release on the production box, or `pulumi up` for infra changes |
| `none`: extension, agent skill, CLI, library, docs | — | — |

## Use

`.github/workflows/deploy.yml` in the app repository:

```yaml
name: Majapi CI/CD

on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened, closed]
  workflow_dispatch:
    inputs:
      deploy_production:
        type: boolean
        default: false

permissions:
  contents: read
  id-token: write
  pull-requests: write

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  deploy:
    uses: majapisoftwares/ci/.github/workflows/deploy.yml@v2
    with:
      deploy_production: ${{ inputs.deploy_production || false }}
    secrets: inherit
```

Fixes within `v2` reach every repository automatically. A breaking change ships as `v3`, and repositories move to it with a one-line change.

## Override

When detection is wrong, add `.majapi/ci.json`:

```json
{ "type": "static", "buildDir": "public" }
```

`type` is `static`, `container` or `none`.

## Previews

Static previews share one bucket behind `*.preview.majapi.com`: a CloudFront function maps `<slug>.preview.majapi.com/<path>` to `s3://<PREVIEW_BUCKET>/<slug>/<path>`, resolving `/` to `index.html` and extensionless paths to `.html`. Caching is disabled there, so every push is visible immediately. These organization variables configure it for every repository:

| Variable | Value |
| --- | --- |
| `PREVIEW_BUCKET` | shared preview bucket |
| `PREVIEW_DEPLOY_ROLE_ARN` | role trusted for `pull_request` runs of `majapisoftwares/*` |
| `PREVIEW_BASE_DOMAIN` | `preview.majapi.com` |

## Container apps

Containers deploy to EC2 boxes over SSM, with Pulumi for infrastructure. Without a `container` block in `.majapi/ci.json` a container repo is only built.

| Event | What runs |
| --- | --- |
| Push to the default branch | The classifier picks a **compiled release** (build, upload, run the app's deploy script on the production box) or, for infra changes, **`pulumi up`** on the `production` stack. |
| PR opened/updated | The shared preview box is started (and provisioned via the `preview-shared` stack if missing). A **compiled preview** always deploys; a **fast preview** (source only) deploys when the classifier allows it; a **full preview** stack (`pr-<n>`) when it requires it. One PR comment shows the latest link. |
| PR closed | The `pr-<n>` stack is destroyed and the app's removal script runs on the box. When no open PR needs previews, the whole `preview-shared` stack (box, disk, IP, DNS, build cache) is **destroyed**; the next preview provisions it again. |
| Daily schedule | Full preview stacks of PRs idle for a day are destroyed, and `preview-shared` too when no PR needs it. |
| `workflow_dispatch` | `deploy_production` forces `pulumi up`; `cleanup_preview_pr` removes one PR's preview, or `shared` destroys `preview-shared` when no PR needs it. |

The app keeps what is specific to it: its Pulumi project, the scripts that run on its boxes, and this block:

```json
{
  "type": "container",
  "container": {
    "classifier": "scripts/classify-preview-deploy.mjs",
    "healthPath": "/api/health/ready",
    "release": {
      "appRoot": "/opt/app/apps/app-${ctx.environment}",
      "deployScript": "scripts/deploy-compiled-release.sh",
      "runtimeHashFile": "scripts/Dockerfile.compiled-runtime"
    },
    "production": { "box": "app-production-box", "runtimeSecretPrefix": "app-production/runtime-", "domains": "${vars.PRODUCTION_DOMAIN}", "buildCommand": "npm run build", "cpu": "2.0", "memory": "3072m" },
    "preview": {
      "box": "app-preview-box", "runtimeSecretPrefix": "app-preview/runtime-",
      "publicDomain": "pr-${ctx.prNumber}.${vars.PREVIEW_DOMAIN}", "appDomain": "app.pr-${ctx.prNumber}.${vars.PREVIEW_DOMAIN}",
      "buildCommand": "npm run build:preview", "fastRoot": "/opt/app/fast-previews/pr-${ctx.prNumber}",
      "fastScript": "scripts/deploy-fast-preview.sh", "removeScript": "scripts/remove-preview.sh"
    },
    "pulumi": {
      "workDir": "infra/pulumi", "project": "app-aws",
      "config": { "aws:region": "${vars.AWS_REGION:-sa-east-1}" },
      "stacks": {
        "production": { "config": { "app-aws:imageTag": "${ctx.imageTag}" }, "env": { "RUNTIME_ENV": "PRODUCTION_ENV" } },
        "preview": { "config": {} },
        "previewShared": { "config": {} }
      }
    }
  }
}
```

- **Placeholders**: `${vars.NAME}`, `${vars.NAME:-fallback}`, `${vars.NAME:+text}` and `${ctx.NAME}` (`prNumber`, `environment`, `stack`, `deploymentEnvironment`, `imageTag`, `gitSha`).
- **`env`** maps environment variables for the Pulumi program to secret names; callers pass `secrets: inherit`.
- **Box scripts** keep a fixed argument order (see `scripts/container/publish-release.sh` and `fast-preview.sh`); the removal script gets the PR number.
- **Required**: `AWS_ROLE_ARN` (secret) or `AWS_DEPLOY_ROLE_ARN` (variable), `PULUMI_STATE_BUCKET`, `PULUMI_CONFIG_PASSPHRASE`. `AWS_BUILD_RUNNER` picks a larger runner for builds.

## Repository variables

| Variable | Used by |
| --- | --- |
| `AWS_REGION` | both (defaults: `us-east-1` static, `sa-east-1` container) |
| `AWS_DEPLOY_ROLE_ARN` | both |
| `STATIC_APP_BUCKET`, `CLOUDFRONT_DISTRIBUTION_ID`, `PUBLIC_APP_URL`, `STATIC_BUILD_DIR` | static production |
| `PRODUCTION_APP_URL` | container production |

`CATALOG_BUCKET`, `CATALOG_DEPLOY_ROLE_ARN` and `CATALOG_DISTRIBUTION_ID` are still read for repositories set up before v2.

## Detection

`scripts/detect.mjs` is shared with Majapi Cloud (`@majapisoftwares/ci/detect`), so the dashboard and the workflow always agree.

```sh
node scripts/detect.mjs path/to/repo
```

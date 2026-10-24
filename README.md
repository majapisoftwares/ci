# Majapi CI

One reusable GitHub Actions workflow for every Majapi repository. It detects the app type on each run and takes the matching path:

| Detected | Preview (PR) | Production (push to default branch) |
| --- | --- | --- |
| `static`: Next.js `output: export`, Vite SPA | S3 under `previews/pr-<n>/` + CloudFront invalidation, removed when the PR closes | S3 sync + CloudFront invalidation |
| `container`: Dockerfile, Next.js SSR, server framework | Classified fast/full preview at `pr-<n>.<PREVIEW_BASE_DOMAIN>` | Build with AWS OIDC |
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

## Repository variables

| Variable | Used by |
| --- | --- |
| `AWS_REGION` | both (defaults: `us-east-1` static, `sa-east-1` container) |
| `AWS_DEPLOY_ROLE_ARN` | both |
| `STATIC_APP_BUCKET`, `CLOUDFRONT_DISTRIBUTION_ID`, `PUBLIC_APP_URL`, `STATIC_BUILD_DIR` | static |
| `PREVIEW_BASE_DOMAIN`, `PRODUCTION_APP_URL` | container |

`CATALOG_BUCKET`, `CATALOG_DEPLOY_ROLE_ARN` and `CATALOG_DISTRIBUTION_ID` are still read for repositories set up before v2.

## Detection

`scripts/detect.mjs` is shared with Majapi Cloud (`@majapisoftwares/ci/detect`), so the dashboard and the workflow always agree.

```sh
node scripts/detect.mjs path/to/repo
```

![Status](https://img.shields.io/badge/status-operational-1a1917?style=flat-square)
![Gateway](https://img.shields.io/badge/gateway-lightweight-1a1917?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-lightgrey?style=flat-square)

# Agent Manifest Diplomat

Public registration gateway for Agent Manifest declarations.

-----

## What this is

The Diplomat is a serverless registration gateway. It receives submitted Agent Manifest declarations, validates them against the canonical v1.0 JSON Schema, and writes accepted manifests to the public dataset repository.

It is infrastructure, not a public-facing conceptual repository. The gateway is intentionally narrow — it validates, rejects duplicates, and appends, nothing more (see [Validation boundary](#validation-boundary)).

-----

## What this is not

- **Not a runtime.** The Diplomat does not execute, observe, or supervise any agent.
- **Not an enforcement engine.** Acceptance into the dataset is not enforcement of declared boundaries.
- **Not a scoring system.** The Diplomat does not rank, rate, score, or compare declarations.
- **Not an authenticated endpoint.** The gateway is open: CORS is `*`, there is no authentication, and there is no rate limiting.
- **Not a compliance authority.** Inclusion of a declaration in the dataset is not a compliance statement about the declaring system.

-----

## Validation boundary

The Diplomat validates every submission against the full canonical [`schema.json`](https://agent-manifest-spec.org/spec/v1.0/schema.json) (JSON Schema draft 2020-12). It keeps no copy of the schema and no validator of its own: both come from [`@agent-manifest/client`](https://www.npmjs.com/package/@agent-manifest/client), so a manifest gets the same verdict here as it does from the CLI. Submissions that fail schema validation are rejected with the validator's error list.

Accepted manifests are persisted to `manifests/YYYY/MM/<agent_id>.json` in the [dataset repository](https://github.com/agent-manifest/agent-manifest-dataset). Writes are append-only by construction: the gateway never passes a `sha` to the GitHub Contents API, so an existing declaration can never be overwritten. A duplicate `agent_id` anywhere in the dataset (checked against `registry.json`, case-insensitively) is rejected with `409`. Resubmitting a byte-identical manifest returns `200` with status `already_registered`, so registration is idempotent.

Limitations that remain, stated plainly:

- the endpoint is open — CORS is `*`, there is no authentication, and there is no rate limiting
- acceptance is a schema-validity and uniqueness check, not a review of the declaration's content

Manifests submitted through the dataset's issue-based registration path (`manifest-submission` issues) are validated against the same schema by that repository's workflow.

-----

## Endpoint

```
POST https://agent-manifest-diplomat.vercel.app/api/register
```

-----

## Request

Send a valid Agent Manifest JSON as the request body.

-----

## Response

Success:
```json
{
  "status": "accepted",
  "agent_id": "your-agent-id",
  "stored_at": "manifests/2026/03/your-agent-id.json",
  "registry_updated": false
}
```

Accepted manifests are persisted to `manifests/YYYY/MM/<agent_id>.json` in the
dataset repository, as reported by `stored_at`.

Note: `registry_updated` is always `false` — the Diplomat writes only the
manifest file and never updates `registry.json` as part of the request. The
registry index is synchronized asynchronously in the dataset repository: its
`Agent Registry` workflow (`build-registry.yml`) regenerates `registry.json`
automatically whenever a push changes `manifests/**` or `registry.json`, so
the index reflects a new registration shortly after the manifest is committed.

Schema validation failure (`400`):
```json
{
  "status": "rejected",
  "errors": ["/manifest_version must be equal to constant"]
}
```

Duplicate `agent_id` (`409`):
```json
{
  "status": "rejected",
  "errors": ["agent_id 'your-agent-id' is already registered at manifests/2026/03/your-agent-id.json. The dataset is append-only; resubmission does not replace an existing declaration."]
}
```

Resubmitting a byte-identical manifest returns `200` with `"status": "already_registered"`.

-----

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GITHUB_TOKEN` | Yes | Personal Access Token with `contents:write` on `DATASET_REPO` |
| `GITHUB_OWNER` | Yes | GitHub org or user that owns the dataset repository |
| `DATASET_REPO` | Yes | Name of the dataset repository |

See `.env.example` for local development defaults.

In production, these must be set as environment variables in the deployment
settings. The function will not write manifests if `GITHUB_TOKEN` is absent
or lacks sufficient permissions.

-----

## Canonical links

- **Specification** — https://agent-manifest-spec.org
- **Schema (v1.0)** — https://agent-manifest-spec.org/spec/v1.0/schema.json
- **Dataset** — https://github.com/agent-manifest/agent-manifest-dataset

-----

## License

MIT License. See [`LICENSE`](./LICENSE).

---

**Part of the [Agent Manifest](https://agent-manifest-spec.org) ecosystem**

[Spec](https://github.com/agent-manifest/agent-manifest) ·
[Registry](https://github.com/agent-manifest/agent-manifest-registry) ·
[Dataset](https://github.com/agent-manifest/agent-manifest-dataset) ·
[Ambassador](https://github.com/agent-manifest/agent-manifest-ambassador) ·
[Diplomat](https://github.com/agent-manifest/agent-manifest-diplomat) ·
[Boundary Handshake](https://github.com/agent-manifest/boundary-handshake) ·
[∈ Principle](https://github.com/agent-manifest/e-principle)

MIT

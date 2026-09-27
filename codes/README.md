# Control Plane Development

The current sandbox workflow is available at `http://127.0.0.1:30207/sandboxes`. An administrator can start a sandbox with a name, open its private Pi Web, configure providers inside that Pi Web, and stop, resume, or delete it. The control plane manages lifecycle and container readiness; it does not provide model credentials to new sandboxes. The model proxy and document QA below remain available as historical modules for existing data.

For an isolated WSL Docker verification, run `sh codes/probes/autonomous-sandbox/environment.sh start` from the repository root. Then run `node codes/probes/autonomous-sandbox/check.mjs` on Windows with `PLAYWRIGHT_PACKAGE_PATH` set to the installed Playwright package. The check creates and deletes its own sandboxes, uses a synthetic model endpoint, and writes screenshots under `docs/testing/evidence/autonomous-sandbox/`. Finish with `sh codes/probes/autonomous-sandbox/environment.sh stop` in WSL; this refuses shutdown while managed sandbox containers remain. The acceptance project's named volume and task directory are local test data and can be removed after verifying they contain no retained sandboxes. See the acceptance record and [resource ledger](../docs/operations/2026-09-27-001-local-docker-ledger.md).

## Local Pi task console

In WSL, run `sh codes/scripts/run-task-preview.sh` from the repository root. The separate `piws-task-preview` project starts at `http://127.0.0.1:30203/tasks`, using the existing administrator key and private secret files. Its database volume and task directory are separate from the older previews, so configure a model connection on this new instance. No real provider call is made by the launcher. Original previews and Pi Web are not recreated.

The task list and `/tasks/:id` detail view support creation, repeated questions, explicit ending, session recovery, and confirmed deletion. The runtime agent alone mounts the Docker socket. Pi runs as UID 10001 with no tools/extensions/skills/context discovery, a read-only root, limited resources, a task-specific workspace, and a read-only token directory. Ending revokes access and cancels active model streams before stopping the retained container. Recovery uses the same container/session and a new token. Deletion removes only resources whose name, labels, image, and mounts match the task.

Run `sh codes/probes/task-runtime/run.sh` for the separate `piws-task-acceptance` project at `http://127.0.0.1:30204/tasks`. This is a synthetic fixed-answer demo, not a real provider. The script resets existing synthetic acceptance tasks and disables old fixture connections only in that project. It verifies actual Pi conversations and recovery, automatic token renewal, failure/cancellation/deletion, non-root and read-only mounts, task file isolation, ownership rejection, and state/reconciliation cases in an isolated database schema. Browser checks are in `probes/task-runtime/browser.mjs` and use `PLAYWRIGHT_PACKAGE_PATH` and `PIWS_ADMIN_KEY_FILE` without printing the key. See the acceptance record.

Before stopping a preview's Compose services, end any running tasks through its UI. Task environments are separately managed and retained until UI deletion; stopping the control services alone does not delete them. This local setup does not provide multi-user authorization, persistent operation idempotency, dependency installation, production audit, or a production deployment plan.

The isolated model protocol probe is under `probes/model-protocol/`. With the local images `node:24-bookworm-slim` and `pi-web-trial:pi-0.87.1` available, run it from the repository root in WSL with `bash codes/probes/model-protocol/run.sh`. It creates a temporary internal Docker network, uses only synthetic tokens and a fixed test upstream, prints compact RPC results, and removes its temporary containers and network on exit. It does not configure a real model provider or run the product proxy.

The Pi token refresh probe is under `probes/pi-token-refresh/`. From the repository root in WSL, run `bash codes/probes/pi-token-refresh/run.sh`. It uses the same local images and a temporary internal Docker network to verify that two prompts in one Pi 0.87.1 RPC process read old and then atomically replaced synthetic task tokens. The test endpoint rejects the old token after the first request. The script removes only its own containers and network; it does not implement product token renewal.

The model proxy's upstream target policy is under `src/model-proxy/`. It validates an approved HTTPS origin and DNS results, then returns the IP used by the internal transport. The policy itself makes no network requests. After building the `codes/Dockerfile` image, run `npm run check` and `npm run test:upstream-policy` inside that image to verify the policy.

The HTTPS transport consumes the policy result, connects to its selected IP, checks the connected address, validates TLS against the original hostname, and streams SSE without following redirects. The product proxy injects the decrypted provider credential through its controlled options. In an isolated container built from `codes/Dockerfile`, run `npm run test:https-transport` alongside the policy test. The synthetic TLS certificate and private key under `src/model-proxy/fixtures/` are test-only fixtures.

The model connection store uses PostgreSQL and AES-256-GCM and is exposed through authenticated internal management routes. Run `sh codes/probes/model-connection-store/run.sh` from the repository root in WSL to build a check image, create an isolated temporary database, run the store and existing proxy checks, and clean up. The test uses only synthetic credentials. The model proxy receives a separate raw 32-byte master key from a read-only file outside the repository; the application never generates or replaces this key on startup. The existing Compose database is not migrated by this probe.

The internal task grant store uses database migrations 2 and 3 and stores only SHA-256 digests of 256-bit random task tokens. New grants expire after one hour and return a renewal time ten minutes before expiry; a rotated predecessor remains usable for at most five minutes. From the repository root in WSL, run `sh codes/probes/task-grant-store/run.sh` to verify issuance, rotation boundaries, revocation, expiry, migration, and concurrent calls against an isolated temporary PostgreSQL container. It does not start a task container, renew tokens on a schedule, or migrate the existing Compose database.

## Local model management workbench

The latest version is available as a separate project on `http://127.0.0.1:30202/models/connections`. Run `sh codes/scripts/run-product-preview.sh` from the repository root in WSL after initializing the original admin preview secrets. It reuses those private secret files, runs API/proxy processes with the invoking user's UID/GID, and creates its own database volume; it does not recreate the existing `30201` containers or copy their model connections. The existing administrator key works on both previews. The page has separate `/models/connections` and `/models/origins` routes and modules for the API client, session, views, and entry point.

From the repository root in WSL, run `sh codes/probes/product-proxy/run.sh` to verify task authorization, limits, stop/disable cancellation, and Pi 0.87.1 RPC through the product proxy and a synthetic TLS upstream. Normal, rejection, interrupted, and missing-DONE streams are checked, with automatic Pi retries disabled and exactly one upstream request per scenario. The fixture substitutes the destination only at test application construction; production always applies the public HTTPS/DNS policy. The script removes only its temporary resources.

The product proxy exposes `POST /v1/chat/completions` for task tokens and authenticated internal task operations. The browser API does not expose task tokens. Limits are documented in [the proxy contract](openapi/model-proxy.yaml). Proxy task state represents model authorization; the separate task service tracks container and conversation state. Read-only token files, scheduling, recovery/deletion, and the task UI are integrated in [the runtime task](../docs/planning/2026-09-27-012-pi-task-runtime.md), with [the browser API contract](openapi/task-management.yaml).

From the repository root in WSL Ubuntu, run `sh codes/scripts/run-admin-preview.sh`. It starts the separate `piws-admin-preview` Compose project at `http://127.0.0.1:30201/` with its own PostgreSQL volume. The launcher creates administrator, service, database, and 32-byte credential master keys in the WSL user's private data directory on first run; later starts reuse the same files. It sets owner-only permissions for the invoking WSL user. In a WSL terminal, run `cat "$HOME/.local/share/pi-workspace-admin-preview/admin-key"`, then enter the result in the browser login form. Do not paste the key into logs or documentation. The API and database never receive the credential master key, and the model management service has no host port.

The page can approve an HTTPS origin, create and list model connections, replace credentials, and disable a connection. It does not run Pi tasks or make provider calls. The preview proxy uses `8.8.8.8` for DNS because the current WSL-provided DNS times out; public-address checks still apply. A synthetic disabled connection and `example.com` origin may be present from acceptance testing. To stop only the preview containers while preserving its volume, run `PIWS_ADMIN_SECRET_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/pi-workspace-admin-preview" docker compose -p piws-admin-preview -f codes/compose.admin.yaml down` from the repository root in WSL.

From the repository root in WSL Ubuntu:

```sh
cd codes
docker run --rm -v "$PWD:/app" -w /app node:24-bookworm-slim node scripts/init-local-db-secret.mjs
docker compose up --build -d
docker compose ps
```

The secret initializer is idempotent. It writes a random password under ignored `codes/.local/`; it never prints the password. Docker Compose keeps PostgreSQL data in a named volume and exposes only the API on the local loopback interface.

Check the API from Windows or WSL:

```sh
curl http://127.0.0.1:30200/health
curl http://127.0.0.1:30200/ready
```

`/health` checks the process; `/ready` checks PostgreSQL and returns HTTP 503 when unavailable. The API source is mounted into its container. For logs and shutdown:

```sh
docker compose logs -f api
docker compose down
```

`docker compose down` preserves the database volume. Dependency or Dockerfile changes require `docker compose up --build -d`; source changes reload through polling because native file events from the Windows mount may not reach WSL containers. Do not use this local setup for real user data or provider credentials until the corresponding storage and access controls are implemented.

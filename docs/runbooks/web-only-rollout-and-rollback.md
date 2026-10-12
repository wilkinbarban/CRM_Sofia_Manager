# Rehearse and run the web-only rollout with rollback

This runbook prepares a rollout. It does not authorize one. Build, deploy, prune and any production mutation stay blocked until the maintainer authorizes them explicitly, with a named image reference and a named operator.

## Scope

Only the `web` service is replaced. The scheduler service and the operational gates are never stopped, recreated or rewritten by this procedure, and `--closed-gates` is not part of it. Host Docker is touched only by the authorized rollout step below; the rehearsal in this document is entirely offline.

Never run, in any step: `docker image prune -a`, `docker system prune`, `docker rm`, `docker rmi`, `docker volume` operations, or any deletion of the active bundle directory, of the `PREVIOUS_ID` image, or of its `rollback-<sha>` tags.

## Preconditions

| Check | How to record it |
|---|---|
| Repository and HEAD | Canonical worktree path plus `HEAD` short id |
| Deploy surface clean | The rollout candidate contains only reviewed commits |
| Reviewed wiring present | The offline rehearsal below passes both its surface checks and its rehearsals |
| Candidate image built and immutable | Image reference plus resolved image ID, built from the reviewed HEAD |
| Rollback target present | The image ID recorded as `PREVIOUS_ID` in `<state_root>/release.env` exists locally |
| Release state readable | `<state_root>/release.env` parses as version 2 and its `BUNDLE_DIR` exists |
| Operator and window | Named operator and UTC window for the rollout |

## Offline rehearsal

Run the rehearsal harness from the deploy worktree. It uses a private sandbox and a fake Docker bridge: it never contacts the daemon and never reaches the network.

```bash
node_modules/.bin/vitest run tests/unit/web-only-p7-dry-run.test.ts \
  --config vitest.config.mts --configLoader runner --no-cache \
  --fileParallelism=false --allowOnly=false --testTimeout=15000
```

What it proves, and what it does not:

- proves the recorded command order (validation before tagging, rollback tags before promotion, promotion from the candidate bundle with an explicit Compose project, publication after promotion, state version 2 retaining its bundle);
- proves the rollback path runs from the bundle's `rollback-compose.json` with the same project binding, and that a failed rollout leaves the recorded state bytes unchanged;
- proves the procedure targets only the `web` service and never runs a broad prune or an automatic bundle deletion;
- proves two consecutive web-only promotions succeed without intervening standard deploys, verifying that the preflight correctly recognizes and accepts the active bundle's compose configuration (H-11);
- proves the surface check has teeth: it detects a deviant copy of the deploy script rather than passing blindly;
- does not prove real daemon behavior, real health timing, real network reachability or visual acceptance. Those require a human on the authorized rollout.

## Rollout

1. **Pre-build verification for the legacy Docker builder (H-9)**:
   The build host operates with the legacy Docker builder (without `buildx` or containerd image store). In this environment, repeated image builds can fail during layer export (`CreateDiff: ... mount callback failed on /var/lib/containerd/tmpmounts/...`) when stopped anonymous intermediate build containers and dangling layers accumulate. `docker image prune -f` reclaims zero bytes while stopped containers reference those layers.
   Execute this checklist before running `docker build`:
   a. Check free disk space: `df -h /` (verify at least 8 GB free space before starting).
   b. Remove stopped anonymous build containers: `docker rm $(docker ps -aq --filter status=exited --filter status=created)` (strictly targeting exited/created containers; never touch running services).
   c. Prune dangling builder layers: `docker image prune -f` (verify space is reclaimed).
   d. Build the candidate image from the reviewed `HEAD`:
      `docker build -t crm-sofia-web:<recorded-tag> .`
   e. Record its immutable image ID: `docker inspect crm-sofia-web:<recorded-tag> --format '{{.Id}}'`. Do not reuse a mutable tag as the candidate reference.
2. Confirm the preconditions table once more, including that the rollback image is still present.
3. Run the authorized web-only deploy, with the image reference recorded in the window ledger:

```bash
scripts/deploy-web.sh deploy --web-only crm-sofia-web:<recorded-tag>
```

The script itself, in order: validates the effective bundle against the real consumer and the live container identity, tags the running image for rollback, promotes the candidate from the candidate bundle, waits for health, runs the read-only smoke checks and the webhook ingress probe, then publishes the version 2 release state atomically.

4. Perform the visual acceptance on the public origin: the web loads, the brand icon and banner resolve, and the login flow renders. Record the outcome as pass or fail; do not edit anything to make it pass.

## Abort and failure handling

| Failure point | Expected behavior |
|---|---|
| Before promotion (preflight, bundle validation, identity parity) | Abort with the script's exit code; no tag, no `up`, no state change, no rollback |
| Promotion or a readiness check fails | The script rolls back from the retained rollback bundle and exits non-zero |
| Publication rejected before commit | The script rolls back and exits non-zero; the recorded state still describes the previous release |
| Publication committed with a durability warning | The release stands; record the warning and verify the state file by hash |
| Publication result unverified | No blind rollback: the candidate and its bundle stay in place, the script exits non-zero, and a human decides whether to roll back |
| Visual acceptance fails | Run the rollback procedure below |

## Rollback

```bash
scripts/deploy-web.sh rollback
```

This reads the version 2 release state, recreates the web service from the recorded rollback bundle with the explicit project binding, waits for health, runs the read-only smoke checks and the ingress probe, and fails closed if the previous image is missing. After it reports success, verify the served origin again and record the image ID that is now running.

## Cleanup after a settled rollout

Only the explicit operator command, and always with a dry run first:

```bash
python3 -B scripts/web_only_bundle_lifecycle.py prune --state-root <state_root> --dry-run
python3 -B scripts/web_only_bundle_lifecycle.py prune --state-root <state_root>
```

The bundle named by the release state and any absolute `--keep` path are protected; directories it cannot remove safely are reported as skipped and the command exits non-zero. Pruning never runs automatically inside a deploy.

## Evidence ledger

Record, and store outside the repository if it contains host paths:

| Field | Value |
|---|---|
| Candidate image reference and image ID | From the build step |
| Bundle directory and manifest SHA-256 | From the publication output |
| Release state hash before and after | SHA-256 of `<state_root>/release.env` |
| Rollout start and end (UTC) | Ledger window |
| Health, smoke, ingress outcomes | Pass or fail, no captured payloads |
| Visual acceptance outcome | Pass or fail, plus what was seen |
| Rollback decision and result | Including the image ID that ended up running |

## Known limits

- The rehearsal is a hermetic sandbox, not OS isolation: it proves command order and contracts, never real daemon behavior.
- A passing rehearsal is a precondition, not an authorization.
- The active bundle must survive a successful rollout; the version 2 rollback path depends on it.
- The build host uses the legacy Docker engine builder without `buildx`; the pre-build checklist in step 1 is required to prevent layer export failures from accumulated anonymous containers.
- Rollback tags and orphaned image layers are out of scope here and belong to a separate cleanup unit.

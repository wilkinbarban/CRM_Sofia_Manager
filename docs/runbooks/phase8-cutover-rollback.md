# Phase 8 cutover and rollback

Phase 8 closes only after a scheduled window produces verified snapshots, read-only smoke evidence, clean operational gates, and a timed web rollback rehearsal. None of the commands in this runbook authorize destructive restore or production-mutating browser tests.

## Before the window

Record the operator, UTC start/end time, release commit, candidate image ID, previous image ID, and abort authority in an evidence file outside the backup directories.

- Use a clean worktree at the release commit. Do not build the release from the migration working tree.
- Retain the immediately previous immutable Web image until the rollback window closes.
- Confirm schema changes are expand/contract compatible with both images.
- Confirm at least one recent Supabase and Evolution backup has valid checksums.
- Never use `npm run test:e2e:production` as a production smoke: that suite creates, edits, reorders, and deletes application data.

## Install backup scheduling

The installer reads the canonical repository path and writes that path into the installed unit. It copies only the unit files, never `.env` or another secret-bearing repository file. Installation deliberately does not enable or start the timer.

```bash
sudo ops/systemd/install-supabase-backup.sh --install
sudo systemctl start asados-supabase-backup.service
sudo systemctl status asados-supabase-backup.service --no-pager
sudo find /var/backups/asados/supabase -mindepth 2 -maxdepth 2 -name SHA256SUMS -print
sudo systemctl enable --now asados-supabase-backup.timer
```

Enable the timer only after the manual service succeeds and the newest backup passes `sha256sum -c SHA256SUMS`.

Evolution currently uses an operator-invoked scheduled wrapper:

```bash
sudo ASADOS_EVOLUTION_BACKUP_ROOT=/var/backups/asados/evolution \
  ops/evolution/scheduled-backup.sh
```

Its snapshot briefly stops only `evolution-api`, then captures PostgreSQL, the Redis volume after `SAVE`, and `/evolution/store`.

## Final snapshots

Create both snapshots immediately before promotion:

```bash
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
sudo ops/supabase/backup.sh "/var/backups/asados/supabase/cutover-$stamp"
sudo ops/evolution/backup.sh "/var/backups/asados/evolution/cutover-$stamp"
```

Record checksums, container image IDs, Compose config hashes, migration count, DNS result, certificate dates, and the current Web/Supabase health responses. Do not place credentials, database rows, cookies, or tokens in the evidence.

## Promotion gates

1. Build and tag the candidate from the recorded clean commit, for example
   `crm-sofia-web:<commit-sha>` or `asados-web:<commit-sha>`. Never use `latest` as the deployment input.
2. Deploy it through the guarded Web workflow:

   ```bash
   sudo scripts/deploy-web.sh deploy "crm-sofia-web:<commit-sha>" \
     | tee "phase8-deploy-$stamp.txt"
   ```

   For targeted Web deployments that must preserve running operational gates and avoid disturbing background maintenance services, pass `--web-only`:

   ```bash
   sudo scripts/deploy-web.sh deploy --web-only "crm-sofia-web:<commit-sha>" \
     | tee "phase8-deploy-$stamp.txt"
   ```

   The script retains the current image under dual immutable rollback tags (`asados-web:rollback-...`
   and `crm-sofia-web:rollback-...`), injects both `CRM_SOFIA_WEB_IMAGE` and `ASADOS_WEB_IMAGE`
   into Docker Compose (where `CRM_SOFIA_WEB_IMAGE` takes precedence), recreates
   only `web`, waits for Docker health, checks exact image identity, and runs the
   direct and HTTPS read-only smoke.

   Web-only deployment constraints:
   - Only `web` is recreated (`docker compose up -d --no-deps --force-recreate web`).
   - The Sofia scheduler (`asados-sofia-inbound-batch-maintenance`) and other core services are never stopped, started, or recreated.
   - Current allowlisted operational gate boolean values are inspected directly from the running Web container configuration before recreation, failing closed if unavailable or malformed.
   - Incompatible flags (`--closed-gates` with `--web-only`) fail closed before any container inspects, tags, or recreations.
   - A failed promotion automatically restores the retained previous image and reapplies preserved operational gates without touching the scheduler. State is committed only on successful promotion.
3. Run `ops/verify-integrations.sh`.
4. Inspect Web, Evolution, Supabase, and ingress logs from the promotion timestamp. Exact understood internet probes may be classified; broad warning/error suppression is forbidden.
5. Confirm the installed backup timer is enabled, scheduled, and has a successful journal entry.

Abort promotion if health, image identity, either origin, an expected private-route denial, integration verification, or the log gate fails.

## Web rollback rehearsal

Rollback changes only the Web image. It never runs a down-migration or restores a database.

Rollback mode governance:
- Plain rollback (`scripts/deploy-web.sh rollback`) is governed by the recorded `release.env` state:
  * When `release.env` records `DEPLOY_MODE=web-only`, plain rollback automatically runs in web-only mode: it restores all 17 allowlisted operational gates (8 payment-proof, 4 notification outbox, and 5 Sofia batch/memory) to their preserved values and never stops, starts, or recreates the Sofia scheduler (`asados-sofia-inbound-batch-maintenance`) or other core services.
  * When `release.env` originates from a legacy release without `DEPLOY_MODE` or records `DEPLOY_MODE=standard`, plain rollback executes legacy behavior: Web is restarted with operational gates closed and the background scheduler stopped.
- Explicit web-only rollback (`scripts/deploy-web.sh rollback --web-only`) requires recorded `DEPLOY_MODE=web-only` with all 17 preserved gate booleans, failing closed if the release state is legacy, standard, or missing gates.

Secure state parser and legacy compatibility:
- `release.env` is verified by a strict, non-executing whitelist parser without shell `source` or `eval` execution.
- The parser validates recognized keys (`PREVIOUS_REF`, `PREVIOUS_ID`, `DEPLOYED_REF`, `DEPLOYED_ID`, `RECORDED_AT`, `DEPLOY_MODE`, `PRESERVED_GATE_*`), image identities (exact 64-hex SHA-256 digests), UTC timestamp syntax, mode values, and all 17 operational gate booleans.
- Duplicate state keys, unknown keys, malformed syntax, or executable tampering fail closed before any Docker mutations.
- Incompatible state files (such as preserved gates without `DEPLOY_MODE`, standard mode with preserved gates, or web-only mode with partial gates) are rejected fail-closed.
- Absent state fields are initialized to empty values and never inherit ambient host environment variables.
- Legacy `release.env` files (complete 5 historical fields without modern mode/gate keys) remain compatible for standard rollback.
- Security limitation: The parser performs strict syntax, format, and image ID string comparison only; it does not provide cryptographic authentication, digital signatures, or tamper-proofing. Because a state file lacks cryptographic signatures, total removal of modern mode/gate fields cannot be proven or distinguished from a genuine historical release.

1. Start a UTC timer and record the rollback decision.
2. Run `sudo scripts/deploy-web.sh rollback` or `sudo scripts/deploy-web.sh rollback --web-only`.
3. Record the script's elapsed time and smoke evidence. It refuses to claim
   success when the retained tag no longer matches its recorded image ID,
   when recorded operational gates are absent or malformed in web-only mode, or
   when recovery takes five minutes or more.

If rollback smoke fails, keep the incident open. Do not claim recovery and do not restore a data backup unless a separate data-loss decision explicitly authorizes it.

## Disaster recovery only

Rehearse these commands in an isolated disposable stack. They are not Web rollback:

```bash
ops/supabase/restore.sh --confirm /path/to/supabase-backup
ops/supabase/restore.sh --confirm --restore-globals /path/to/supabase-backup
ops/evolution/restore.sh --confirm /path/to/evolution-backup
```

Supabase globals are skipped by default because applying role definitions can change cluster-wide authentication. Use `--restore-globals` only for a new disaster-recovery cluster after reviewing `globals.sql`.

## Closure evidence

- Final checksummed Supabase and Evolution snapshots passed archive validation.
- The daily Supabase timer is installed and enabled, and a real scheduled service run produced a verified artifact.
- Direct-origin and HTTPS read-only smoke tests, health and isolation checks, and the integration verifier passed against the immutable Web deployment.
- The previous immutable Web image was restored successfully in 9 seconds.
- Disposable restore stacks recovered 24 Supabase `public` tables and 37 Evolution `public` tables.
- A malformed external `Next-Action: s4` request failed closed with HTTP 404 and `x-nextjs-action-not-found`; this exact request was classified as an understood internet probe.
- The log review was scoped to the Asados virtual host, and the remaining ingress logs were clean.

## Closure checklist

- [x] Window, operator, release identity, previous image, and abort authority recorded.
- [x] Final Supabase and Evolution snapshots verified.
- [x] Candidate health, direct-origin, HTTPS, isolation, and integration gates passed.
- [x] Logs reviewed without broad filters.
- [x] Scheduled Supabase backup produced and verified a real artifact.
- [x] Previous-image rollback completed in under five minutes.
- [x] Evidence contains no secrets or production row data.
- [x] `docs/implementation-plan.md` Phase 8 evidence and checkboxes updated only after every item above passes.

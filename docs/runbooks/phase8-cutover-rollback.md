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
2. Deploy it through the guarded Web-only workflow:

   ```bash
   sudo scripts/deploy-web.sh deploy "crm-sofia-web:<commit-sha>" \
     | tee "phase8-deploy-$stamp.txt"
   ```

   The script retains the current image under dual immutable rollback tags (`asados-web:rollback-...`
   and `crm-sofia-web:rollback-...`), injects both `CRM_SOFIA_WEB_IMAGE` and `ASADOS_WEB_IMAGE`
   into Docker Compose (where `CRM_SOFIA_WEB_IMAGE` takes precedence), recreates
   only `web`, waits for Docker health, checks exact image identity, and runs the
   direct and HTTPS read-only smoke. A failed promotion automatically restores
   the retained image.
3. Run `ops/verify-integrations.sh`.
4. Inspect Web, Evolution, Supabase, and ingress logs from the promotion timestamp. Exact understood internet probes may be classified; broad warning/error suppression is forbidden.
5. Confirm the installed backup timer is enabled, scheduled, and has a successful journal entry.

Abort promotion if health, image identity, either origin, an expected private-route denial, integration verification, or the log gate fails.

## Web rollback rehearsal

Rollback changes only the Web image. It never runs a down-migration or restores a database. Both an explicit rollback and an automatic promotion rollback explicitly start Web with all six payment-proof startup gates set to `false`, overriding any open operator-shell values before health and read-only smoke; gate values are not printed.

1. Start a UTC timer and record the rollback decision.
2. Run `sudo scripts/deploy-web.sh rollback`.
3. Record the script's elapsed time and smoke evidence. It refuses to claim
   success when the retained tag no longer matches its recorded image ID or
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

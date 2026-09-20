import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8')

describe('Phase 8 operational artifacts', () => {
  it('restores only current Supabase services and makes globals explicit', () => {
    const restore = read('ops', 'supabase', 'restore.sh')

    expect(restore).toContain('clients="studio api-gw auth rest realtime storage meta functions"')
    expect(restore).not.toMatch(/clients=.*(?:imgproxy|supavisor)/)
    expect(restore).toContain('--restore-globals')
    expect(restore).toContain('trap restart_clients EXIT')
  })

  it('backs up and restores all persistent Evolution stores with checksums', () => {
    for (const name of ['backup.sh', 'scheduled-backup.sh', 'restore.sh']) {
      expect(existsSync(join(root, 'ops', 'evolution', name))).toBe(true)
    }
    const backup = read('ops', 'evolution', 'backup.sh')
    const restore = read('ops', 'evolution', 'restore.sh')

    expect(backup).toContain('database.dump')
    expect(backup).toContain('redis.tar.gz')
    expect(backup).toContain('store.tar.gz')
    expect(backup).toContain('SHA256SUMS')
    expect(restore).toContain('sha256sum -c SHA256SUMS')
    expect(restore).toContain('trap restart_services EXIT')
  })

  it('installs backup units without copying repository secrets or activating the timer', () => {
    const installer = read('ops', 'systemd', 'install-supabase-backup.sh')

    expect(installer).toContain('repo_root=')
    expect(installer).toContain('ExecStart=$repo_root/ops/supabase/scheduled-backup.sh')
    expect(installer).not.toMatch(/\bcp\b.*\.env|\binstall\b.*\.env/)
    expect(installer).not.toMatch(/systemctl\s+enable|systemctl\s+start/)
    expect(installer).toContain('systemd-analyze verify')
  })

  it('keeps production smoke read-only and identity-aware', () => {
    const smoke = read('scripts', 'smoke-production-readonly.sh')

    expect(smoke).toContain('ASADOS_EXPECTED_IMAGE_ID')
    expect(smoke).toContain('docker inspect asados-web')
    expect(smoke).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/)
    expect(smoke).toContain('/api/health/ready')
    expect(smoke).toContain('/login')
  })

  it('deploys and rolls back only Web from immutable local image tags', () => {
    const compose = read('docker-compose.yml')
    const deploy = read('scripts', 'deploy-web.sh')

    expect(compose).toContain('image: ${ASADOS_WEB_IMAGE:-asados-web:latest}')
    expect(deploy).toContain('deploy <local-immutable-image-ref>')
    expect(deploy).toContain('deploy --closed-gates <local-immutable-image-ref>')
    expect(deploy).toContain('rollback')
    expect(deploy).toContain('--no-deps --force-recreate web')
    expect(deploy).toContain('ASADOS_COMPOSE_PROJECT')
    expect(deploy).toContain('{{index .Config.Labels "com.docker.compose.project"}}')
    expect(deploy).not.toContain('--project-name asados')
    expect(deploy.match(/--project-name "\$compose_project"/g)).toHaveLength(3)
    expect(deploy).toContain('ASADOS_EXPECTED_IMAGE_ID="$expected_id"')
    expect(deploy).toContain('Promotion failed; restoring the retained previous image')
    expect(deploy).toContain('recreate_and_verify "$rollback_ref" "$previous_id" true')
    expect(deploy).toContain('recreate_and_verify "$PREVIOUS_REF" "$PREVIOUS_ID" true')
    for (const gate of [
      'PAYMENT_PROOF_CANONICAL_INGEST_ENABLED=false',
      'WHATSAPP_PAYMENT_PROOF_INGEST_ENABLED=false',
      'PAYMENT_PROOF_PROCESSING_ENABLED=false',
      'PAYMENT_PROOF_SELLER_RECONCILIATION_ENABLED=false',
      'PAYMENT_PROOF_PRIVILEGED_REPLAY_ENABLED=false',
      'PAYMENT_PROOF_CLEANUP_ENABLED=false',
      'SOFIA_INBOUND_BATCH_PROCESSING_ENABLED=false',
      'SOFIA_INBOUND_BATCH_RUNTIME_ENABLED=false',
      'SOFIA_INBOUND_BATCH_TELEGRAM_ENQUEUE_ENABLED=false',
      'SOFIA_INBOUND_BATCH_EVOLUTION_ENQUEUE_ENABLED=false',
    ]) expect(deploy).toContain(gate)
    expect(compose).toContain('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED=${SOFIA_INBOUND_BATCH_RUNTIME_ENABLED:-false}')
    expect(deploy).toContain('recreate_and_verify "$candidate_ref" "$candidate_id" "$close_operational_gates"')
    expect(deploy).toContain('ASADOS_DEPLOY_STATE_ROOT')
    expect(deploy).not.toMatch(/docker compose[^\\n]*(?:db|auth|storage|evolution)/)
  })
})

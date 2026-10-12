import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8')

function shellFunction(source: string, name: string) {
  const body = source.match(new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)^\\}`, 'm'))
  expect(body, `missing deploy function: ${name}`).not.toBeNull()
  return body![1]
}

function projectBoundComposeCalls(source: string) {
  // Join shell continuations before discovery, including env prefixes and Docker host options.
  const lines = source.replace(/\\\r?\n/g, ' ').split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
  const calls = lines.flatMap(line => {
    // Require command-token whitespace: docker-compose.yml is an argument, not another call.
    const starts = [...line.matchAll(/\bdocker(?=[ \t])[^\n]*?[ \t]compose(?=[ \t]|$)/g)]
    // Fail closed rather than borrowing a binding from another command on the same line.
    expect(starts.length, `multiple Compose calls on one logical line: ${line}`).toBeLessThanOrEqual(1)
    return starts.map(start => line.slice(start.index).split(/\|\||&&|;/, 1)[0])
  })
  expect(calls.length, 'expected at least one Compose invocation').toBeGreaterThan(0)
  for (const call of calls) {
    expect(call).toMatch(/\bcompose\b.*--project-name "\$compose_project"(?:\s|$)/)
  }
  return calls
}

describe('Phase 8 operational artifacts', () => {
  it('distinguishes Compose commands from filenames and rejects missing project bindings', () => {
    const binding = '--project-name "$compose_project"'
    const direct = `docker compose -f "$root/docker-compose.yml" ${binding} up -d web`
    expect(projectBoundComposeCalls(direct)).toEqual([direct])
    expect(() => projectBoundComposeCalls(direct.replace(binding, ''))).toThrow()
    expect(() => projectBoundComposeCalls(`${direct}; ${direct}`)).toThrow()

    const hostEnv = [
      'env "${env_args[@]}"',
      'CRM_SOFIA_WEB_IMAGE="$ref"',
      'ASADOS_WEB_IMAGE="$ref" docker --host "$docker_endpoint" compose',
      `-f "$root/docker-compose.yml" ${binding} up -d web`,
    ].join(' \\\n  ')
    const hostCalls = projectBoundComposeCalls(hostEnv)
    expect(hostCalls).toHaveLength(1)
    expect(hostCalls[0]).toContain('docker --host "$docker_endpoint" compose')
    expect(() => projectBoundComposeCalls(hostEnv.replace(binding, ''))).toThrow()
    expect(() => projectBoundComposeCalls('')).toThrow()
    expect(() => projectBoundComposeCalls('printf "%s" "$root/docker-compose.yml"')).toThrow()
  })

  it('binds each deployment and recovery route to the resolved Compose project', () => {
    const deploy = read('scripts', 'deploy-web.sh')
    const standard = shellFunction(deploy, 'recreate_and_verify')
    const branches = standard.match(/if \[\[ "\$close_operational_gates" == true \]\]; then\n([\s\S]*?)\n  else\n([\s\S]*?)\n  fi/)
    expect(branches, 'standard closed/open gate branches').not.toBeNull()
    for (const branch of [branches![1], branches![2]]) {
      expect(projectBoundComposeCalls(branch).join('\n')).toContain('up -d --no-deps --force-recreate web')
    }

    const webOnly = shellFunction(deploy, 'recreate_and_verify_web_only')
    expect(webOnly).toContain('env "${env_args[@]}"')
    expect(projectBoundComposeCalls(webOnly).join('\n')).toContain('up -d --no-deps --force-recreate web')
    const bundle = shellFunction(deploy, 'recreate_and_verify_bundle')
    const bundleCalls = projectBoundComposeCalls(bundle).join('\n')
    expect(bundleCalls).toContain('compose -f "$compose_file"')
    expect(bundleCalls).toContain('up -d --no-deps --force-recreate web')

    const state = shellFunction(deploy, 'load_state')
    const configCalls = projectBoundComposeCalls(state).join('\n')
    expect(configCalls).toContain('docker --host "$docker_endpoint" compose')
    expect(configCalls).toContain('config --format json')
    const preflight = shellFunction(deploy, 'validate_web_only_preflight')
    expect(preflight).toContain('"$root/scripts/web-only-target-preflight.py"')
    expect(preflight).toContain('--root "$root" --project "$compose_project"')

    const rollbackStart = deploy.lastIndexOf('\n  rollback)\n')
    expect(rollbackStart).toBeGreaterThan(0)
    const rollback = deploy.slice(rollbackStart)
    const legacyStart = rollback.indexOf('\n    require_immutable_local_image')
    expect(legacyStart).toBeGreaterThan(0)
    const v2Rollback = rollback.slice(0, legacyStart)
    expect(v2Rollback).toContain('if [[ "${STATE_VERSION:-}" == "2" ]]; then')
    const rollbackCalls = projectBoundComposeCalls(v2Rollback).join('\n')
    expect(rollbackCalls).toContain('compose -f "$V2_ROLLBACK_COMPOSE"')
    expect(rollbackCalls).toContain('up -d --no-deps --force-recreate web')
  })

  it('restores only current Supabase services and makes globals explicit', () => {
    const restore = read('ops', 'supabase', 'restore.sh')

    expect(restore).toContain('clients="api-gw auth rest realtime storage functions"')
    expect(restore).not.toMatch(/clients=.*(?:studio|meta|imgproxy|supavisor)/)
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

    expect(compose).toContain('image: ${CRM_SOFIA_WEB_IMAGE:-${ASADOS_WEB_IMAGE:-asados-web:latest}}')
    expect(deploy).toContain('CRM_SOFIA_WEB_IMAGE="$ref"')
    expect(deploy).toContain('ASADOS_WEB_IMAGE="$ref"')
    expect(deploy).toContain('crm-sofia-web:rollback-')
    expect(deploy).toContain('asados-web:rollback-')
    expect(deploy).toContain('deploy <local-immutable-image-ref>')
    expect(deploy).toContain('deploy --closed-gates <local-immutable-image-ref>')
    expect(deploy).toContain('deploy --web-only <local-immutable-image-ref>')
    expect(deploy).toContain('rollback')
    expect(deploy).toContain('rollback --web-only')
    expect(deploy).toContain('--no-deps --force-recreate web')
    expect(deploy).toContain('ASADOS_COMPOSE_PROJECT')
    expect(deploy).toContain('{{index .Config.Labels "com.docker.compose.project"}}')
    expect(deploy).not.toContain('--project-name asados')
    projectBoundComposeCalls(deploy)
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

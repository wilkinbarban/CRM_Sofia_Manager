import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SOFIA_BATCH_MAINTENANCE_CADENCE_SECONDS,
  SOFIA_BATCH_MAINTENANCE_CADENCE_MS,
} from '@/lib/sofia/response-pace'
import { TELEGRAM_TYPING_RESTART_FLOOR_MS } from '@/lib/sofia/inbound-batch-worker'

const root = process.cwd()
const schedulerPath = 'ops/sofia-inbound-batch-maintenance-scheduler.sh'
const scheduler = readFileSync(join(root, schedulerPath), 'utf8')
const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8')
const deploy = readFileSync(join(root, 'scripts/deploy-web.sh'), 'utf8')
const temporaryDirectories: string[] = []

function temporaryDirectory(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(dir)
  return dir
}

function executable(dir: string, name: string, body: string) {
  const path = join(dir, name)
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

function runScheduler(options: { fail?: boolean; interval?: string | null; secret?: string } = {}) {
  const dir = temporaryDirectory('sofia-scheduler-')
  const markerPath = join(dir, 'last-success')
  const calls = join(dir, 'calls')
  writeFileSync(calls, '')
  writeFileSync(markerPath, 'unchanged')
  executable(dir, 'curl', `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CALLS"\n[ "${options.fail ? '1' : '0'}" = 0 ]\n`)
  const sleeps = join(dir, 'sleeps')
  writeFileSync(sleeps, '')
  executable(dir, 'sleep', '#!/bin/sh\nprintf \'%s\\n\' "$1" >> "$SLEEPS"\nexit 1\n')
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: calls, SLEEPS: sleeps,
    SOFIA_BATCH_MAINTENANCE_SECRET: options.secret ?? 'sofia-private',
    SOFIA_BATCH_MAINTENANCE_URL: 'http://maintenance.local',
    SOFIA_BATCH_MAINTENANCE_MARKER_PATH: markerPath }
  if (options.interval !== null) env.SOFIA_BATCH_MAINTENANCE_INTERVAL_SECONDS = options.interval ?? '60'
  else delete env.SOFIA_BATCH_MAINTENANCE_INTERVAL_SECONDS
  const result = spawnSync('sh', [schedulerPath], { cwd: root, encoding: 'utf8', env })
  return { result, calls: readFileSync(calls, 'utf8'), markerPath, sleeps: readFileSync(sleeps, 'utf8') }
}

function healthcheck(marker: string | undefined, interval = '2', now = 1_000) {
  const service = compose.slice(compose.indexOf('  sofia-inbound-batch-maintenance:'), compose.indexOf('  evolution-api:'))
  const block = service.slice(service.indexOf('        - >-') + '        - >-'.length, service.indexOf('      interval: 30s'))
  const command = block.split('\n').map(line => line.trim()).filter(Boolean).join(' ').replaceAll('$$', '$')
  const dir = temporaryDirectory('sofia-healthcheck-')
  const markerPath = join(dir, 'last-success')
  executable(dir, 'date', `#!/bin/sh\nprintf '%s\\n' ${now}\n`)
  executable(dir, 'cat', `#!/bin/sh\n[ "$1" = "$EXPECTED_MARKER_PATH" ] || exit 1\n[ "${marker === undefined ? '0' : '1'}" = 1 ] || exit 1\nprintf '%s' '${marker ?? ''}'\n`)
  return spawnSync('sh', ['-c', command], {
    encoding: 'utf8',
    env: {
      ...process.env,
      EXPECTED_MARKER_PATH: markerPath,
      PATH: `${dir}:${process.env.PATH}`,
      SOFIA_BATCH_MAINTENANCE_INTERVAL_SECONDS: interval,
      SOFIA_BATCH_MAINTENANCE_MARKER_PATH: markerPath,
    },
  })
}

describe('Sofia inbound batch maintenance scheduler', () => {
  afterEach(() => {
    for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { force: true, recursive: true })
  })

  it('writes the numeric marker only after an authenticated curl succeeds without disclosing its secret', () => {
    expect(scheduler).toContain(': "${SOFIA_BATCH_MAINTENANCE_MARKER_PATH:=/tmp/sofia-inbound-batch-maintenance-last-success}"')
    expect(scheduler).toContain('date +%s > "$SOFIA_BATCH_MAINTENANCE_MARKER_PATH"')
    const failed = runScheduler({ fail: true })
    expect(readFileSync(failed.markerPath, 'utf8')).toBe('unchanged')
    const succeeded = runScheduler()
    expect(succeeded.calls).toContain('Authorization: Bearer sofia-private')
    expect(readFileSync(succeeded.markerPath, 'utf8').trim()).toMatch(/^\d+$/)
    expect(`${failed.result.stdout}${failed.result.stderr}${succeeded.result.stdout}${succeeded.result.stderr}`).not.toContain('sofia-private')
  })

  it('defaults to the two-second inspection cadence and accepts its lower boundary', () => {
    expect(runScheduler({ interval: null }).sleeps).toBe('2\n')
    expect(runScheduler({ interval: '2' }).sleeps).toBe('2\n')
  })

  it('rejects absent, invalid, and unsafe scheduler intervals before invoking curl', () => {
    for (const options of [{ secret: '' }, { interval: 'nope' }, { interval: '0' }, { interval: '715827883' }]) {
      const run = runScheduler(options)
      expect(run.result.status).not.toBe(0)
      expect(run.calls).toBe('')
    }
  })

  it('accepts one second only as an explicit faster-than-required interval', () => {
    expect(runScheduler({ interval: '1' }).sleeps).toBe('1\n')
  })

  it('executes a deterministic healthcheck that accepts only fresh numeric markers within bounded tolerance', () => {
    expect(healthcheck('1000').status).toBe(0)
    expect(healthcheck(undefined).status).not.toBe(0)
    expect(healthcheck('not-an-epoch').status).not.toBe(0)
    expect(healthcheck('819').status).not.toBe(0)
    expect(healthcheck('1060').status).not.toBe(0)
    expect(healthcheck('820').status).toBe(0)
    expect(healthcheck('1005').status).toBe(0)
    expect(healthcheck('820', 'invalid').status).toBe(0)
  })

  it('installs scheduler only for normal promotion and stops it for both closed recovery paths', () => {
    expect(compose).toContain('SOFIA_BATCH_MAINTENANCE_URL=http://web:3000/api/internal/sofia/inbound-batches/maintenance')
    expect(compose).toContain('SOFIA_BATCH_MAINTENANCE_INTERVAL_SECONDS=${SOFIA_BATCH_MAINTENANCE_INTERVAL_SECONDS:-2}')
    expect(compose).toContain('SOFIA_BATCH_MAINTENANCE_MARKER_PATH=${SOFIA_BATCH_MAINTENANCE_MARKER_PATH:-/tmp/sofia-inbound-batch-maintenance-last-success}')
    expect(compose).toContain('interval=$${SOFIA_BATCH_MAINTENANCE_INTERVAL_SECONDS:-2};')
    expect(compose).toContain('marker_path=$${SOFIA_BATCH_MAINTENANCE_MARKER_PATH:-/tmp/sofia-inbound-batch-maintenance-last-success};')
    expect(compose).toContain('exec /bin/sh /scheduler/sofia-inbound-batch-maintenance-scheduler.sh')
    expect(compose).toContain('marker=$$(cat "$$marker_path") || exit 1')
    expect(deploy).toContain('wait_sofia_scheduler_healthy')
    const recreate = deploy.match(/^recreate_and_verify\(\) \{\n([\s\S]*?)^\}/m)
    expect(recreate, 'standard promotion/recovery function').not.toBeNull()
    expect(recreate![1]).toMatch(/wait_healthy[ \t]+\|\|[ \t]+return 1\s+if \[\[ "\$close_operational_gates" == true \]\]; then\s+stop_sofia_scheduler[ \t]+\|\|[ \t]+return 1\s+else\s+recreate_sofia_scheduler[ \t]+\|\|[ \t]+return 1\s+fi\b/)
    expect(deploy).toContain('--no-deps --force-recreate sofia-inbound-batch-maintenance')
    expect(deploy).toContain('docker stop asados-sofia-inbound-batch-maintenance')
    expect(deploy).toContain('if [[ "$close_operational_gates" == true ]]; then\n    stop_sofia_scheduler')
    expect(deploy).toContain('recreate_and_verify "$rollback_ref" "$previous_id" true')
    expect(deploy).toContain('recreate_and_verify "$PREVIOUS_REF" "$PREVIOUS_ID" true')
    for (const gate of [
      'SOFIA_INBOUND_BATCH_PROCESSING_ENABLED=false',
      'SOFIA_INBOUND_BATCH_RUNTIME_ENABLED=false',
      'SOFIA_INBOUND_BATCH_TELEGRAM_ENQUEUE_ENABLED=false',
      'SOFIA_INBOUND_BATCH_EVOLUTION_ENQUEUE_ENABLED=false',
    ]) expect(deploy).toContain(gate)
    expect(compose).toContain('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED=${SOFIA_INBOUND_BATCH_RUNTIME_ENABLED:-false}')
    expect(deploy).toContain('recreate_and_verify "$candidate_ref" "$candidate_id" "$close_operational_gates"')
  })

  it('aligns scheduler default cadence with worker restart floor and response-pace constants', () => {
    expect(SOFIA_BATCH_MAINTENANCE_CADENCE_SECONDS).toBe(2)
    expect(SOFIA_BATCH_MAINTENANCE_CADENCE_MS).toBe(2_000)
    expect(TELEGRAM_TYPING_RESTART_FLOOR_MS).toBe(SOFIA_BATCH_MAINTENANCE_CADENCE_MS)
    expect(scheduler).toContain(
      `: "\${SOFIA_BATCH_MAINTENANCE_INTERVAL_SECONDS:=${SOFIA_BATCH_MAINTENANCE_CADENCE_SECONDS}}"`
    )
    expect(compose).toContain(
      `SOFIA_BATCH_MAINTENANCE_INTERVAL_SECONDS=\${SOFIA_BATCH_MAINTENANCE_INTERVAL_SECONDS:-${SOFIA_BATCH_MAINTENANCE_CADENCE_SECONDS}}`
    )
    expect(compose).toContain(
      `interval=\$\${SOFIA_BATCH_MAINTENANCE_INTERVAL_SECONDS:-${SOFIA_BATCH_MAINTENANCE_CADENCE_SECONDS}};`
    )
  })
})

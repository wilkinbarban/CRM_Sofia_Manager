import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const runnerPath = join(root, 'scripts/run-local-supabase-service-tests.sh')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}
const workflow = readFileSync(join(root, '.github/workflows/pull-request.yml'), 'utf8')

// The only lines the runner may ever print for a failed startup or reset. Anything
// else (raw log lines, paths, URLs, credentials) is a leak by definition.
const allowedDiagnostic =
  /^(?:migration-file: \d{14}_[a-z0-9_]+\.sql|sqlstate: [0-9a-z]{5}|startup-unhealthy-or-not-ready|port-conflict|container-runtime-unavailable|migration-or-database-error|startup-timeout)$/

const reportDiagnosticsSource = (() => {
  const block = readFileSync(runnerPath, 'utf8').match(/^report_failure_log\(\) \{[\s\S]*?^\}/m)?.[0]
  if (!block) throw new Error('scripts/run-local-supabase-service-tests.sh is missing report_failure_log')
  return block
})()

// Feeds a synthetic log through stdin and a process substitution, so the probe never
// creates a file, never reads the repository, and never contacts Docker.
function classifyFailureLog(input: string) {
  return spawnSync('bash', ['-c', `${reportDiagnosticsSource}\nreport_failure_log <(cat)`], {
    cwd: root,
    encoding: 'utf8',
    input,
  })
}

function expectDiagnosticsAreSafe(stderr: string) {
  const lines = stderr.split('\n').filter((line) => line !== '')
  expect(lines.length).toBeGreaterThan(0)
  expect(lines.length).toBeLessThanOrEqual(20)
  for (const line of lines) expect(line).toMatch(allowedDiagnostic)
  expect(stderr).not.toMatch(/[/@?&=]/)
}

describe('local Supabase service-backed test runner', () => {
  it('is executable and has dedicated package and CI entry points', () => {
    expect(existsSync(runnerPath)).toBe(true)
    expect(packageJson.scripts['test:unit:supabase']).toBe('scripts/run-local-supabase-service-tests.sh')
    expect(workflow).toContain('run: npm run test:unit:supabase')
    expect(() => execFileSync('test', ['-x', runnerPath])).not.toThrow()
  })

  it('pins the local target and serializes exactly the two service-backed suites', () => {
    const runner = readFileSync(runnerPath, 'utf8')

    expect(runner).toContain("readonly local_api_url='http://127.0.0.1:55321'")
    expect(runner).toContain('ports = {54321: 55321')
    expect(runner).toContain("'auto_expose_new_tables = true'")
    expect(runner).toContain("r'\\1true'")
    expect(runner).toContain("SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN='local-test-only'")
    expect(runner).toContain("readonly protected_project='xvzdxoktwnzmxsfizkxo'")
    expect(runner).toContain("'tests/unit/roles-authentication-e2e.test.ts'")
    expect(runner).toContain("'tests/unit/web-client-operator-cart-flow.test.ts'")
    expect(runner).toContain('--fileParallelism=false')
    expect(runner).toContain('npx supabase db reset --local --workdir "$work/project"')
    expect(runner).toContain('npx supabase stop --workdir "$work/project" --no-backup')
    expect(runner).toContain("pattern = re.compile(r'^alter function public\\.[^;]+ owner to supabase_admin;")
    expect(runner).toContain("if changed != 8:")
    expect(runner).toContain("trap cleanup EXIT")
  })

  it.each(['start', 'reset'])('classifies %s failures into fixed labels without leaking raw evidence', (phase) => {
    const runner = readFileSync(runnerPath, 'utf8')
    expect(runner).toContain(`report_failure_log "$work/${phase}.log"`)

    const secrets = [
      'leaked-password', 'leaked-bearer-token', 'sb_secret_leaked', 'eyJzdWIiOiJsZWFrZWQifQ',
      '/home/private-user/secret-checkout', '/var/run/docker.sock',
      'postgresql://postgres:leaked-password@127.0.0.1:5432/postgres',
      'http://127.0.0.1:55321/health', 'private_leads', 'db.internal',
    ]
    const input = [
      'Applying migration 20250101000000_initial.sql',
      'Applying migration 20250101000001_add_secret_column.sql',
      'supabase_db_project container is not ready: unhealthy (POSTGRES_PASSWORD=leaked-password)',
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock (SERVICE_ROLE_KEY=sb_secret_leaked)',
      'Bind for 0.0.0.0:55321 failed: port is already allocated',
      'ERROR: relation "private_leads" does not exist for user postgres@db.internal',
      'FATAL: password authentication failed for postgresql://postgres:leaked-password@127.0.0.1:5432/postgres',
      'context deadline exceeded while waiting for http://127.0.0.1:55321/health with Authorization: Bearer leaked-bearer-token',
      '/home/private-user/secret-checkout/supabase/config.toml is not readable',
      'NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJsZWFrZWQifQ.c2ln',
      'ordinary line that matches no category',
    ].join('\n')
    const result = classifyFailureLog(input)

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('migration-file: 20250101000000_initial.sql')
    expect(result.stderr).toContain('startup-unhealthy-or-not-ready')
    expect(result.stderr).toContain('port-conflict')
    expect(result.stderr).toContain('container-runtime-unavailable')
    expect(result.stderr).toContain('migration-or-database-error')
    expect(result.stderr).toContain('startup-timeout')
    expectDiagnosticsAreSafe(result.stderr)
    for (const secret of secrets) expect(result.stderr).not.toContain(secret)
  })

  it('keeps the last five validated migration filenames so the failing migration survives', () => {
    // Issue #222: the first five July migrations hid the migration that actually
    // failed at the tail of the log. The report must retain the LAST five instead.
    const input = Array.from(
      { length: 8 },
      (_, index) => `Applying migration 2025010100000${index}_seed_step_${index}.sql`,
    ).join('\n')
    const result = classifyFailureLog(input)

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expectDiagnosticsAreSafe(result.stderr)
    expect(result.stderr.split('\n').filter((line) => line !== '')).toEqual([
      'migration-file: 20250101000003_seed_step_3.sql',
      'migration-file: 20250101000004_seed_step_4.sql',
      'migration-file: 20250101000005_seed_step_5.sql',
      'migration-file: 20250101000006_seed_step_6.sql',
      'migration-file: 20250101000007_seed_step_7.sql',
    ])
    expect(result.stderr).not.toContain('seed_step_0')
    expect(result.stderr).not.toContain('seed_step_1')
    expect(result.stderr).not.toContain('seed_step_2')
  })

  it('surfaces only a strict five-character SQLSTATE code and no surrounding message', () => {
    const input = [
      'Applying migration 20250101000001_seed_step_1.sql',
      'FAILED to apply migration: ERROR: relation "private_leads" does not exist (SQLSTATE 42P01)',
      'ordinary line that matches no category',
    ].join('\n')
    const result = classifyFailureLog(input)

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expectDiagnosticsAreSafe(result.stderr)
    expect(result.stderr).toContain('migration-file: 20250101000001_seed_step_1.sql')
    expect(result.stderr).toContain('sqlstate: 42p01')
    expect(result.stderr).toContain('migration-or-database-error')
    expect(result.stderr).not.toContain('private_leads')
    expect(result.stderr).not.toContain('does not exist')
  })

  it('rejects non-five-character or embedded SQLSTATE candidates and leaks no context', () => {
    const input = [
      'SQLSTATE 1234',
      'SQLSTATE 123456',
      'SQLSTATE leaked-password',
      'SQLSTATE eyJhbGciOiJIUzI1NiJ9',
      'SQLSTATE /home/private-user/secret-checkout',
      'sqlstate=SERVICE_ROLE_KEY',
    ].join('\n')
    const result = classifyFailureLog(input)

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  it('retains every migration filename when the log has five or fewer', () => {
    const input = Array.from(
      { length: 5 },
      (_, index) => `Applying migration 2025010100000${index}_seed_step_${index}.sql`,
    ).join('\n')
    const result = classifyFailureLog(input)

    expect(result.stderr.split('\n').filter((line) => line !== '')).toEqual([
      'migration-file: 20250101000000_seed_step_0.sql',
      'migration-file: 20250101000001_seed_step_1.sql',
      'migration-file: 20250101000002_seed_step_2.sql',
      'migration-file: 20250101000003_seed_step_3.sql',
      'migration-file: 20250101000004_seed_step_4.sql',
    ])
  })

  it('reports the last SQLSTATE candidate while discarding everything around it', () => {
    const input = [
      'sqlstate 42601 earlier failure',
      'sqlstate 23505 later failure password=leaked-password',
    ].join('\n')
    const result = classifyFailureLog(input)

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expectDiagnosticsAreSafe(result.stderr)
    expect(result.stderr).toContain('sqlstate: 23505')
    expect(result.stderr).not.toContain('42601')
    expect(result.stderr).not.toContain('password')
    expect(result.stderr).not.toContain('leaked-password')
  })

  it.each(['start', 'reset'])('bounds the %s diagnostic output under a malicious flood', (phase) => {
    const runner = readFileSync(runnerPath, 'utf8')
    expect(runner).toContain(`report_failure_log "$work/${phase}.log"`)

    const flood = Array.from(
      { length: 400 },
      (_, index) => `ERROR: leaked /home/private-user/secret-${index} password=leaked-${index} token=eyJ${index}`,
    )
    const input = [
      'container is not ready: unhealthy',
      'port is already allocated',
      'cannot connect to the docker daemon',
      ...flood,
      'context deadline exceeded',
    ].join('\n')
    const result = classifyFailureLog(input)

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expectDiagnosticsAreSafe(result.stderr)
    expect(result.stderr).not.toContain('secret-399')
    expect(result.stderr.length).toBeLessThan(2000)
  })

  it('stops scanning at its line bound and reports no raw tail beyond it', () => {
    const input = [
      'Bind for 0.0.0.0:55321 failed: port is already allocated',
      ...Array.from({ length: 2500 }, (_, index) => `ordinary line ${index}`),
      'container is not ready: unhealthy',
    ].join('\n')
    const result = classifyFailureLog(input)

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expectDiagnosticsAreSafe(result.stderr)
    expect(result.stderr).toContain('port-conflict')
    expect(result.stderr).not.toContain('startup-unhealthy-or-not-ready')
  })

  it('stops scanning at its byte bound and reports nothing from the truncated tail', () => {
    const input = 'x'.repeat(600_000) + '\ncontainer is not ready: unhealthy\n'
    const result = classifyFailureLog(input)

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  it('never prints an unrecognized line, never repeats a label, and reports nothing for empty input', () => {
    const input = [
      'totally unknown output with /home/private-user and token=abc',
      'unhealthy',
      'the container is unhealthy again',
      'not ready',
      'Address already in use',
      'failed to start containers: exit status 1',
      '/tmp/whatever api_key=deadbeef',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.signature',
    ].join('\n')
    const result = classifyFailureLog(input)

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expectDiagnosticsAreSafe(result.stderr)
    const lines = result.stderr.split('\n').filter((line) => line !== '')
    expect(lines).toEqual([...new Set(lines)])
    expect(lines).toContain('startup-unhealthy-or-not-ready')
    expect(lines).toContain('container-runtime-unavailable')
    expect(lines).toContain('port-conflict')
    expect(result.stderr).not.toContain('deadbeef')
    expect(result.stderr).not.toContain('api_key')
    expect(result.stderr).not.toContain('eyJ')

    const empty = classifyFailureLog('')
    expect(empty.status).toBe(0)
    expect(empty.stdout).toBe('')
    expect(empty.stderr).toBe('')
  })

  it('reports the same fixed label order regardless of log order', () => {
    const forward = classifyFailureLog('unhealthy\nport already in use\nERROR: leaked /home/private-user/x')
    const shuffled = classifyFailureLog('ERROR: leaked /home/private-user/x\nport already in use\nunhealthy')

    expect(shuffled.stderr).toBe(forward.stderr)
    expect(forward.stderr.split('\n').filter((line) => line !== '')).toEqual([
      'startup-unhealthy-or-not-ready',
      'port-conflict',
      'migration-or-database-error',
    ])
  })

  it('does not classify a healthy log as a startup failure', () => {
    const result = classifyFailureLog(
      [
        'supabase_db_project container is healthy',
        'http://127.0.0.1:55321/health returned 200',
        'waiting for health checks to settle',
      ].join('\n'),
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  it('classifies only explicit readiness failures as unhealthy', () => {
    const failing = [
      'container is not ready',
      'supabase_db_project container is unhealthy',
      'readiness probe failed for supabase_db_project',
      'health check failed for supabase_db_project',
    ]
    for (const line of failing) {
      const result = classifyFailureLog(line)
      expect(result.status).toBe(0)
      expect(result.stderr).toContain('startup-unhealthy-or-not-ready')
    }

    for (const line of ['container is healthy', 'health check passed', 'health checks are progressing']) {
      expect(classifyFailureLog(line).stderr).toBe('')
    }
  })

  it('never leaks the private log path when the log read races the failure branch', () => {
    // Simulates the race the guard cannot close: the log was readable when the guard
    // ran, but `head`/`tr` can no longer open it. Their stderr carries the ephemeral
    // private path, so the pipeline must silence it without silencing the labels.
    const script = [
      reportDiagnosticsSource,
      `head() { printf 'head: cannot open %s: No such file or directory\\n' "\${!#}" >&2; return 1; }`,
      `tr() { printf 'tr: failed to read input\\n' >&2; return 1; }`,
      'report_failure_log "$1"',
    ].join('\n')
    const result = spawnSync('bash', ['-c', script, 'diagnostic-test', runnerPath], {
      cwd: root,
      encoding: 'utf8',
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
    expect(result.stderr).not.toContain(runnerPath)
  })

  it('runs only the copied receipt pgTAP file locally after safety gates and before Vitest and teardown', () => {
    const runner = readFileSync(runnerPath, 'utf8')
    const reset = runner.indexOf('npx supabase db reset --local --workdir "$work/project"')
    const safety = runner.indexOf('Safety gate rejected missing or placeholder local Supabase credentials.')
    const pathGuard = runner.indexOf('[[ -f "$receipt_test" && ! -L "$receipt_test" && ! -L "$work/project/supabase/tests" ]]')
    const pgTap = runner.indexOf('npx supabase test db --local --workdir "$work/project" "$receipt_test"')
    const vitest = runner.indexOf('scripts/workspace-preflight.sh run -- npx vitest run')

    expect(runner).toContain('receipt_test="$work/project/supabase/tests/sales_receipt_issuance.sql"')
    expect(runner).toContain('cp -a supabase "$work/project/supabase"')
    expect(runner).toContain('npx supabase stop --workdir "$work/project" --no-backup')
    expect(runner).not.toMatch(/supabase test db[^\n]*(?:--linked|--db-url)/)
    expect(reset).toBeGreaterThan(-1)
    expect(safety).toBeGreaterThan(reset)
    expect(pathGuard).toBeGreaterThan(safety)
    expect(pgTap).toBeGreaterThan(pathGuard)
    expect(vitest).toBeGreaterThan(pgTap)
    expect(runner).toContain('exit "$code"')
  })

  it('keeps the cleanup and exit paths of the runner unchanged', () => {
    const runner = readFileSync(runnerPath, 'utf8')

    expect(runner).toContain('trap cleanup EXIT')
    expect(runner).toContain('rm -rf "$work"')
    expect(runner).toContain('exit "$code"')
    expect(runner).toContain('started_by_runner=true')
    expect(runner).toContain('Disposable local Supabase failed to start.')
    expect(runner).toContain('Disposable local Supabase reset or seed failed.')
    expect(runner).not.toMatch(/tail -n \d+/)
  })

  it('rejects every test outside its allowlist before contacting Docker', () => {
    const result = spawnSync('bash', [runnerPath, 'tests/unit/safe-redirect.test.ts'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: '/usr/bin:/bin' },
    })

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Only the two service-backed Supabase suites may run')
    expect(result.stdout).toBe('')
  })
})

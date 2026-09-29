import { chmodSync, mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// The isolated rollback-candidate harness is a fail-closed lifecycle runner. These
// tests only exercise the hermetic guard layer (`plan`) and the static lifecycle
// invariants of the script. They never start Docker workloads, a Supabase stack or
// an image build: the actual image-level compatibility evidence belongs to the
// independent verification phase.
const root = process.cwd()
const harnessPath = join(root, 'scripts/test-rollback-candidate-isolated.sh')

const PINNED_SOURCE_COMMIT = '6eecb20502dbbfc8b5dc7c776d439443b306edb3'
const PRODUCTION_PROJECT_REF = 'xvzdxoktwnzmxsfizkxo'
const PRODUCTION_ORIGIN = 'crmsofiamanager.duckdns.org'
const PRODUCTION_IMAGE_ID = 'sha256:aa040fc915d1b6b75ecf9fcf26ec61f1c57cb56cdda75442bee34918dc856d74'

const sandboxes: string[] = []

type Sandbox = {
  dir: string
  binDir: string
  logPath: string
  lockBase: string
  env: (extra?: Record<string, string>) => NodeJS.ProcessEnv
}

function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'rollback-harness-test-'))
  sandboxes.push(dir)
  const binDir = join(dir, 'bin')
  const lockBase = join(dir, 'lock')
  const logPath = join(dir, 'docker.log')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(lockBase, { recursive: true })
  writeFileSync(logPath, '')

  // Boundary stub: records every call and answers only the inspection subcommands
  // the guard layer is allowed to use. It fails closed (exit 1) for everything else
  // so an accidental build/run during `plan` surfaces as a failure.
  const fakeDocker = join(binDir, 'docker')
  writeFileSync(
    fakeDocker,
    [
      '#!/bin/sh',
      'printf \'%s\\n\' "$*" >> "$FAKE_BIN_LOG"',
      'sub="${1:-}"',
      '[ "$sub" = "info" ] && {',
      '  [ "${FAKE_DOCKER_INFO_FAIL:-0}" = "1" ] && exit 1',
      '  exit 0',
      '}',
      'case "$sub" in',
      '  network|container|image|volume)',
      '    shift',
      '    action="${1:-}"',
      '    shift || true',
      '    target="${1:-}"',
      '    case " ${FAKE_DOCKER_EXISTS:-} " in',
      '      *" $target "*) exit 0 ;;',
      '    esac',
      '    exit 1',
      '    ;;',
      'esac',
      'exit 1',
      '',
    ].join('\n'),
  )
  chmodSync(fakeDocker, 0o755)

  const fakeNpx = join(binDir, 'npx')
  writeFileSync(
    fakeNpx,
    [
      '#!/bin/sh',
      'printf \'npx %s\\n\' "$*" >> "$FAKE_BIN_LOG"',
      'if [ "${1:-}" = "--no-install" ]; then shift; fi',
      'if [ "${1:-}" = "supabase" ] && [ "${2:-}" = "status" ]; then',
      '  [ "${FAKE_SUPABASE_RUNNING:-0}" = "1" ] && exit 0',
      '  exit 1',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
  )
  chmodSync(fakeNpx, 0o755)

  return {
    dir,
    binDir,
    logPath,
    lockBase,
    env: (extra = {}) => ({
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME ?? dir,
      TMPDIR: dir,
      FAKE_BIN_LOG: logPath,
      ROLLBACK_HARNESS_LOCK_DIR: join(lockBase, 'lock'),
      ROLLBACK_HARNESS_WORK_BASE: join(dir, 'work'),
      ROLLBACK_HARNESS_MIN_FREE_BYTES: '0',
      ROLLBACK_HARNESS_RUN_ID: 'unittest',
      ...extra,
    }),
  }
}

function runHarness(sandbox: Sandbox, args: string[], extra: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync('bash', [harnessPath, ...args], {
    cwd: root,
    env: sandbox.env(extra),
    encoding: 'utf8',
  })
}

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('isolated rollback-candidate compatibility harness', () => {
  it('resolves a deterministic image-level plan bound to the pinned rollback-candidate commit', () => {
    const sandbox = makeSandbox()
    const result = runHarness(sandbox, ['plan'])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('mode=plan')
    expect(result.stdout).toContain('runtime=image-build+disposable-supabase+loopback-probe')
    expect(result.stdout).toContain(`source_commit=${PINNED_SOURCE_COMMIT}`)
    expect(result.stdout).toContain('public_url=http://127.0.0.1:')
    expect(result.stdout).toContain('web_url=http://127.0.0.1:')
    expect(result.stdout).toContain('network_name=supabase_network_rollback-harness-unittest')
    expect(result.stdout).toContain('container_name=rollback-candidate-isolated-unittest-web')
    expect(result.stdout).toContain(`min_free_bytes=12884901888`)

    // Planning is a guard-only step: it must never build, run or mutate Docker state.
    const dockerLog = readFileSync(sandbox.logPath, 'utf8')
    expect(dockerLog).not.toMatch(/^(build|run|create|start|rm|rmi|stop)\b/m)
    expect(result.stdout).not.toContain(PRODUCTION_ORIGIN)
    expect(result.stdout).not.toContain(PRODUCTION_PROJECT_REF)
  })

  it.each([
    ['ROLLBACK_HARNESS_IMAGE_TAG', 'asados-web:4d897d994bee8aa7332b57ca13dfad1d4c3c8430'],
    ['ROLLBACK_HARNESS_LOCK_DIR', `/tmp/${PRODUCTION_PROJECT_REF}/lock`],
    ['ROLLBACK_HARNESS_PROBE_PATH', `/${PRODUCTION_ORIGIN}/admin`],
    ['ROLLBACK_HARNESS_EXPECTED_DIGEST', PRODUCTION_IMAGE_ID],
  ])('refuses production identifier supplied through %s', (name, value) => {
    const sandbox = makeSandbox()
    const result = runHarness(sandbox, ['plan'], { [name]: value })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('production identifier')
    expect(result.stderr).not.toContain(value)
  })

  it.each([['NEXT_PUBLIC_SUPABASE_URL'], ['SUPABASE_INTERNAL_URL'], ['SUPABASE_SERVICE_ROLE_KEY']])(
    'refuses inherited Supabase environment variable %s instead of reusing it',
    (name) => {
      const sandbox = makeSandbox()
      const result = runHarness(sandbox, ['plan'], { [name]: `https://${PRODUCTION_ORIGIN}` })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain(`inherited Supabase environment: ${name}`)
    },
  )

  it.each([
    ['http://10.0.0.7:55521'],
    ['http://172.17.0.1:55521'],
    ['https://supabase.internal.example'],
    ['http://0.0.0.0:55521'],
  ])('refuses a non-loopback synthetic public URL %s', (publicUrl) => {
    const sandbox = makeSandbox()
    const result = runHarness(sandbox, ['plan'], { ROLLBACK_HARNESS_PUBLIC_URL: publicUrl })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('must be loopback')
  })

  it('refuses to start without disk headroom above the required threshold', () => {
    const sandbox = makeSandbox()
    const required = String(1024 * 1024 * 1024 * 1024 * 1024)
    const result = runHarness(sandbox, ['plan'], { ROLLBACK_HARNESS_MIN_FREE_BYTES: required })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('disk headroom')
    expect(result.stderr).toContain(required)
  })

  it.each([
    'supabase_network_rollback-harness-unittest',
    'rollback-candidate-isolated-unittest-web',
    'asados-web-harness:6eecb20-unittest',
  ])('refuses a collision with an already existing harness-owned resource %s', (owned) => {
    const sandbox = makeSandbox()
    const result = runHarness(sandbox, ['plan'], { FAKE_DOCKER_EXISTS: owned })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('already exists')
    expect(result.stderr).toContain(owned)
  })

  it('refuses to start a second disposable Supabase stack while a local stack is running', () => {
    const sandbox = makeSandbox()
    const result = runHarness(sandbox, ['plan'], { FAKE_SUPABASE_RUNNING: '1' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Refusing to start a second disposable Supabase stack')
  })

  it('refuses to continue when the Docker daemon is unavailable', () => {
    const sandbox = makeSandbox()
    const result = runHarness(sandbox, ['plan'], { FAKE_DOCKER_INFO_FAIL: '1' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Docker is unavailable')
  })

  it('refuses a source commit that is not present in this repository', () => {
    const sandbox = makeSandbox()
    const result = runHarness(sandbox, ['plan'], { ROLLBACK_HARNESS_SOURCE_COMMIT: '0'.repeat(40) })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('not present in this repository')
  })

  it('refuses to continue while another harness run holds the lock', () => {
    const sandbox = makeSandbox()
    const lockDir = join(sandbox.lockBase, 'lock', 'run.lock')
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, 'pid'), `${process.pid}\n`)

    const result = runHarness(sandbox, ['plan'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Another isolated rollback harness run is active')
  })

  it('fails closed on a stale harness lock instead of silently reclaiming it', () => {
    const sandbox = makeSandbox()
    const lockDir = join(sandbox.lockBase, 'lock', 'run.lock')
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, 'pid'), '2147483646\n')

    const result = runHarness(sandbox, ['plan'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('stale harness lock')
    expect(existsSync(lockDir)).toBe(true)
  })

  it('rejects an unknown subcommand with a usage error', () => {
    const sandbox = makeSandbox()
    const result = runHarness(sandbox, ['promote'])

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Usage:')
  })

  it('is an executable bash harness pinned to the rollback-candidate source commit', () => {
    expect(existsSync(harnessPath)).toBe(true)
    const harness = readFileSync(harnessPath, 'utf8')

    expect(harness.startsWith('#!/usr/bin/env bash\n')).toBe(true)
    expect(harness).toContain('set -Eeuo pipefail')
    expect(harness).toContain('set +x')
    expect(harness).toContain('umask 077')
    expect(harness).toContain(PINNED_SOURCE_COMMIT)
    expect(harness).toContain(PRODUCTION_PROJECT_REF)
    expect(harness).toContain(PRODUCTION_ORIGIN)
    expect(harness).toContain('12884901888')
  })

  it('extracts the pinned source without mutating the working tree and builds it with a loopback public URL', () => {
    const harness = readFileSync(harnessPath, 'utf8')

    expect(harness).toContain('git -C "$root" archive --format=tar "$source_commit"')
    expect(harness).not.toMatch(/git\s+(-C\s+\S+\s+)?worktree\s+add/)
    expect(harness).not.toMatch(/git\s+(checkout|switch|reset|clean|stash|restore)/)

    const buildLine = harness.split('\n').find((line) => line.includes('docker build'))
    expect(buildLine).toBeDefined()
    expect(buildLine).toContain('--build-arg "NEXT_PUBLIC_SUPABASE_URL=$public_url"')
    expect(buildLine).toContain('--build-arg "NEXT_PUBLIC_SUPABASE_ANON_KEY=$synthetic_anon_key"')

    expect(harness).toMatch(/public_url="http:\/\/127\.0\.0\.1:\$\{api_port\}"/)
    expect(harness).not.toMatch(/--build-arg[^\n]*duckdns/)
  })

  it('runs the built image only on the harness-owned network with loopback-only publication', () => {
    const harness = readFileSync(harnessPath, 'utf8')

    expect(harness).toContain('--network "$owned_network"')
    expect(harness).toContain('--name "$owned_container"')
    expect(harness).toContain('-p "127.0.0.1:${web_port}:3000"')
    expect(harness).not.toMatch(/--network\s+host/)
    expect(harness).not.toMatch(/--network\s+["']?(bridge|asados-app-private|asados-supabase-private|portafolio-net)["']?/)
    expect(harness).not.toMatch(/--privileged/)
    expect(harness).not.toMatch(/docker\s+compose/)
    expect(harness).not.toMatch(/\bprune\b/)
    expect(harness).not.toMatch(/-v\s+\/var\/run\/docker\.sock/)
  })

  it('proves compatibility through a real loopback image probe rather than a static scan', () => {
    const harness = readFileSync(harnessPath, 'utf8')

    expect(harness).toContain('/api/health/live')
    expect(harness).toContain('curl ')
    expect(harness).toContain('http://127.0.0.1:${web_port}${probe_path}')
    expect(harness).toContain('--max-time')
    expect(harness).toContain("docker image inspect \"$owned_image\" --format '{{.Id}}'")
    expect(harness).not.toMatch(/grep\s+-[a-z]*\s+['"][^'"]*Dockerfile/)
  })

  it('cleans up only the resources the run created and never touches production state', () => {
    const harness = readFileSync(harnessPath, 'utf8')

    const cleanupStart = harness.indexOf('cleanup() {')
    expect(cleanupStart).toBeGreaterThan(-1)
    const cleanup = harness.slice(cleanupStart, harness.indexOf('\n}\n', cleanupStart))

    expect(cleanup).toContain('docker rm -f "$owned_container"')
    expect(cleanup).toContain('docker rmi "$owned_image"')
    expect(cleanup).toContain('npx --no-install supabase stop --workdir "$work/project" --no-backup')
    expect(cleanup).toContain('rm -rf "$work"')
    expect(cleanup).toContain('started_by_runner')
    expect(cleanup).not.toMatch(/release\.env/)
    expect(cleanup).not.toMatch(/crm-sofia-web|asados-supabase|asados-app-private/)

    expect(harness).toContain('trap cleanup EXIT')
    expect(harness).toContain("trap 'cleanup; trap - EXIT; exit 129' HUP")
    expect(harness).toContain("trap 'cleanup; trap - EXIT; exit 130' INT")
    expect(harness).toContain("trap 'cleanup; trap - EXIT; exit 143' TERM")

    expect(harness).not.toContain('release.env')
    expect(harness).not.toMatch(/(^|\s)(source|\.)\s+\S*\.env\b/m)
    expect(harness).not.toMatch(/cp\s+\S*\.env/)
    expect(harness).not.toMatch(/--env-file/)
    expect(harness).not.toMatch(/docker\s+(volume|network)\s+prune/)
  })

  it('records the synthesised credentials from the disposable stack and rejects protected values', () => {
    const harness = readFileSync(harnessPath, 'utf8')

    expect(harness).toContain('npx --no-install supabase start --workdir "$work/project"')
    expect(harness).toContain('npx --no-install supabase db reset --local --workdir "$work/project"')
    expect(harness).toContain('npx --no-install supabase status --workdir "$work/project" -o env')
    expect(harness).toContain('Safety gate rejected a non-local or protected Supabase target.')
    expect(harness).toContain('Safety gate rejected missing or placeholder synthetic credentials.')
    expect(harness).not.toMatch(/set -x/)
  })
})

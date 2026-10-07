/**
 * A1b-1 Docker Process Boundary test suite: real process spawn boundary, closed bin/env isolation.
 * Part of autonomous A1b chain:
 * - A1b-1: Hermetic process & filesystem boundary fixture (tests/helpers/web-docker-process-boundary.ts),
 *   reusing trusted web-private-sandbox, real spawned deny-only docker/curl executables,
 *   exact NDJSON argv boundary logging, closed child env/PATH whitelist, and identity-safe cleanup.
 * - A1b-2 (deferred): Subprocess bridge to certified dispatcher, state sharing and lifecycle tests.
 *
 * PROVENANCE & HARNESS DESIGN LEDGER:
 * 1. Private FS & Root: 0700 root in canonical tmp, binDir & opRoot subdirs, delegated cleanup.
 * 2. Closed Bin Whitelist: Exact 19 tool stubs (bash, sh, python3, sleep, date, awk, grep, cat,
 *    tr, flock, rm, mv, mkdir, cp, sed, dirname, basename, docker, curl), all executable.
 * 3. Real Spawn Deny-Only: Status 1, empty stdout, deny stderr; proven real child execution via stub rewrite.
 * 4. Deterministic NDJSON Argv Log: Exact boundaries for spaces, empty strings, quotes, newlines,
 *    shell metacharacters, and Unicode across sequential calls; no timestamp or credentials.
 * 5. Child Env Isolation: Whitelist only (PATH, HOME, TMPDIR, LC_ALL, PYTHONDONTWRITEBYTECODE);
 *    sentinel absence proven via test-owned python3 -B probe inside boundary dir, zero process.env mutation.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { existsSync, statSync, readFileSync, readdirSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const EXPECTED_TOOLS = [
  'awk', 'bash', 'basename', 'cat', 'cp', 'curl', 'date', 'dirname', 'docker',
  'flock', 'grep', 'mkdir', 'mv', 'python3', 'rm', 'sed', 'sh', 'sleep', 'tr',
] as const

export const CHILD_ENV_KEYS = [
  'PATH', 'HOME', 'TMPDIR', 'LC_ALL', 'PYTHONDONTWRITEBYTECODE',
] as const

export interface ProcessResult {
  status: number | null
  stdout: string
  stderr: string
}

export interface CommandLogEntry {
  command: string
  args: string[]
}

export interface DockerProcessBoundary {
  readonly dir: string
  readonly binDir: string
  readonly opRoot: string
  readonly commandsLog: string
  readonly childEnv: Readonly<Record<string, string>>
  runDocker: (args: string[], ambientEnv?: NodeJS.ProcessEnv) => ProcessResult
  runCurl: (args: string[], ambientEnv?: NodeJS.ProcessEnv) => ProcessResult
  cleanup: () => void
}

export interface WebDockerProcessBoundaryHelper {
  readonly EXPECTED_TOOLS?: readonly string[]
  readonly CHILD_ENV_KEYS?: readonly string[]
  createDockerProcessBoundary: (ambientEnv?: NodeJS.ProcessEnv) => DockerProcessBoundary
}

const HELPER_PATH = join(process.cwd(), 'tests/helpers/web-docker-process-boundary.ts')
const helperExists = existsSync(HELPER_PATH)
let helperModule: WebDockerProcessBoundaryHelper | null = null

if (helperExists) {
  const helperUrl = pathToFileURL(HELPER_PATH).href
  helperModule = (await import(/* @vite-ignore */ helperUrl)) as WebDockerProcessBoundaryHelper
}

function getHelper(): WebDockerProcessBoundaryHelper {
  if (!helperExists || !helperModule) {
    throw new Error(
      `web-docker-process-boundary capability missing: ${HELPER_PATH} does not exist. ` +
      'Independent capability RED prerequisite: helper must be implemented before behavior contracts run.'
    )
  }
  return helperModule
}

let boundary: DockerProcessBoundary | null = null

afterEach(() => {
  if (boundary) {
    boundary.cleanup()
    boundary = null
  }
})

describe('web-docker-process-boundary A1b-1: real process boundary, closed bin and env isolation', () => {
  it('creates private 0700 root in canonical tmp with exact 19 closed executable tool stubs', () => {
    const { createDockerProcessBoundary } = getHelper()
    boundary = createDockerProcessBoundary()

    expect(existsSync(boundary.dir)).toBe(true)
    const dirStat = statSync(boundary.dir)
    expect(dirStat.mode & 0o777).toBe(0o700)

    const canonicalTmp = realpathSync(tmpdir())
    expect(realpathSync(boundary.dir).startsWith(canonicalTmp + '/')).toBe(true)

    const canonicalDir = realpathSync(boundary.dir)
    expect(existsSync(boundary.binDir)).toBe(true)
    expect(realpathSync(boundary.binDir).startsWith(canonicalDir + '/')).toBe(true)

    expect(existsSync(boundary.opRoot)).toBe(true)
    expect(realpathSync(boundary.opRoot).startsWith(canonicalDir + '/')).toBe(true)
    expect(boundary.commandsLog.startsWith(boundary.dir + '/')).toBe(true)

    const entries = readdirSync(boundary.binDir).sort()
    expect(entries).toEqual([...EXPECTED_TOOLS].sort())
    expect(entries).toHaveLength(19)

    for (const name of entries) {
      const toolPath = join(boundary.binDir, name)
      const toolStat = statSync(toolPath)
      expect(toolStat.mode & 0o111, `${name} must be executable`).not.toBe(0)
    }
  })

  it('spawns real deny-only docker and curl processes returning exit 1, empty stdout, and deny stderr', () => {
    const { createDockerProcessBoundary } = getHelper()
    boundary = createDockerProcessBoundary()

    // 1. Separate denial assertions on original stubs
    const dockerRes = boundary.runDocker(['ps', '-aq'])
    expect(dockerRes.status).toBe(1)
    expect(dockerRes.stdout).toBe('')
    expect(dockerRes.stderr).toMatch(/deny unauthorized filter/i)

    const curlRes = boundary.runCurl(['http://127.0.0.1:8080/health'])
    expect(curlRes.status).toBe(1)
    expect(curlRes.stdout).toBe('')
    expect(curlRes.stderr).toMatch(/deny.*curl/i)

    // 2. Prove actual subprocess execution by safely rewriting boundary-owned stubs
    for (const [tool, runner, markerName, code] of [
      ['docker', (args: string[]) => boundary!.runDocker(args), 'docker-marker.txt', 42],
      ['curl', (args: string[]) => boundary!.runCurl(args), 'curl-marker.txt', 43],
    ] as const) {
      const stubPath = join(boundary.binDir, tool)
      const originalBytes = readFileSync(stubPath)
      const originalMode = statSync(stubPath).mode
      const markerPath = join(boundary.dir, markerName)
      try {
        writeFileSync(
          stubPath,
          `#!/bin/sh\nprintf "${tool}-mark:%s" "$1" > "${markerPath}"\nprintf "${tool}-out"\nprintf "${tool}-err" >&2\nexit ${code}\n`,
          { mode: 0o755 },
        )
        const res = runner(['probe-arg'])
        expect(res.status).toBe(code)
        expect(res.stdout).toBe(`${tool}-out`)
        expect(res.stderr).toBe(`${tool}-err`)
        expect(existsSync(markerPath)).toBe(true)
        expect(readFileSync(markerPath, 'utf8')).toBe(`${tool}-mark:probe-arg`)
      } finally {
        writeFileSync(stubPath, originalBytes, { mode: originalMode })
      }
    }
  })

  it('records exact NDJSON argv boundaries preserving spaces, empty strings, quotes, newlines, shell chars, and Unicode', () => {
    const { createDockerProcessBoundary } = getHelper()
    boundary = createDockerProcessBoundary()

    const complexDockerArgs = [
      'inspect', 'crm-sofia web', '', 'line1\nline2', '"quoted"', 'cat & dog | tee', 'emoji-🚀-áéíóú',
    ]
    const complexCurlArgs = [
      '-X', 'POST', 'https://example.test/api path', '-d', '{"key": "value", "empty": ""}', '$VAR; rm -rf /',
    ]
    const sequentialDockerArgs = ['ps', '--format', '{{.ID}}\t{{.Image}}']

    boundary.runDocker(complexDockerArgs)
    boundary.runCurl(complexCurlArgs)
    boundary.runDocker(sequentialDockerArgs)

    const logContent = readFileSync(boundary.commandsLog, 'utf8').trim()
    const lines = logContent.split('\n')
    expect(lines).toHaveLength(3)

    const parsed: CommandLogEntry[] = lines.map((line) => JSON.parse(line))

    expect(parsed[0].command).toBe('docker')
    expect(parsed[0].args).toEqual(complexDockerArgs)

    expect(parsed[1].command).toBe('curl')
    expect(parsed[1].args).toEqual(complexCurlArgs)

    expect(parsed[2].command).toBe('docker')
    expect(parsed[2].args).toEqual(sequentialDockerArgs)

    for (const line of lines) {
      expect(line).not.toContain('"timestamp"')
      expect(line).not.toContain('"time"')
    }
  })

  it('enforces child environment whitelist and proves sentinel absence in child process via safe probe', () => {
    const { createDockerProcessBoundary } = getHelper()
    const sentinelAmbient: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      HOME: '/home/safe',
      TMPDIR: '/tmp',
      LC_ALL: 'C',
      PYTHONDONTWRITEBYTECODE: '1',
      DOCKER_HOST: 'tcp://malicious-host:2375',
      CRM_SECRET_SENTINEL: 'forbidden-credential-xyz',
    }

    boundary = createDockerProcessBoundary(sentinelAmbient)

    expect(boundary.childEnv.DOCKER_HOST).toBeUndefined()
    expect(boundary.childEnv.CRM_SECRET_SENTINEL).toBeUndefined()
    expect(boundary.childEnv.PYTHONDONTWRITEBYTECODE).toBe('1')
    expect(boundary.childEnv.PATH).toBe(boundary.binDir)

    const exposedKeys = Object.keys(boundary.childEnv)
    for (const key of exposedKeys) {
      expect(CHILD_ENV_KEYS).toContain(key)
    }

    const probePath = join(boundary.dir, 'probe-env.py')
    writeFileSync(probePath, 'import os, json\nprint(json.dumps(dict(os.environ)))\n', { mode: 0o600 })

    const probeRes = spawnSync(join(boundary.binDir, 'python3'), ['-B', probePath], {
      env: boundary.childEnv,
      encoding: 'utf8',
    })
    expect(probeRes.status).toBe(0)
    const probeEnv = JSON.parse(probeRes.stdout)
    expect(probeEnv.CRM_SECRET_SENTINEL).toBeUndefined()
    expect(probeEnv.DOCKER_HOST).toBeUndefined()
    expect(probeEnv.PYTHONDONTWRITEBYTECODE).toBe('1')
    expect(probeEnv.PATH).toBe(boundary.binDir)

    for (const key of Object.keys(probeEnv)) {
      expect(CHILD_ENV_KEYS).toContain(key)
    }

    boundary.runDocker(['ps'], { CALL_SENTINEL: 'call-secret-abc' })
    const log = readFileSync(boundary.commandsLog, 'utf8')
    expect(log).not.toContain('CALL_SENTINEL')
    expect(log).not.toContain('call-secret-abc')
  })

  it('performs idempotent cleanup delegating root removal to private sandbox helper', () => {
    const { createDockerProcessBoundary } = getHelper()
    boundary = createDockerProcessBoundary()
    const ownedDir = boundary.dir

    expect(existsSync(ownedDir)).toBe(true)
    boundary.cleanup()
    expect(existsSync(ownedDir)).toBe(false)

    expect(() => boundary?.cleanup()).not.toThrow()
    boundary = null
  })
})

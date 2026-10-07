/**
 * Hermetic process and filesystem boundary helper for Docker/curl operations.
 * Reuses web-private-sandbox for 0700 root, closed 19-tool binDir, NDJSON logging,
 * and whitelist-only child environment isolation.
 */
import { appendFileSync, existsSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createPrivateSandbox } from './web-private-sandbox'

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

function buildChildEnv(binDir: string, ambient?: NodeJS.ProcessEnv): Record<string, string> {
  const src = ambient ?? process.env
  const env: Record<string, string> = { PATH: binDir }
  for (const key of CHILD_ENV_KEYS) {
    if (key === 'PATH') continue
    const val = src[key]
    if (typeof val === 'string') {
      env[key] = val
    }
  }
  return env
}

export function createDockerProcessBoundary(
  ambientEnv?: NodeJS.ProcessEnv,
): DockerProcessBoundary {
  const sandbox = createPrivateSandbox('web-docker-pb-')
  const binDir = sandbox.mkdir('bin', 0o755)
  const opRoot = sandbox.mkdir('opRoot', 0o700)
  const commandsLog = join(sandbox.dir, 'commands.ndjson')
  const childEnv = Object.freeze(buildChildEnv(binDir, ambientEnv))

  for (const tool of EXPECTED_TOOLS) {
    const targetPath = join(binDir, tool)
    if (tool === 'docker' || tool === 'curl') {
      const script = `#!/bin/sh\nprintf "deny: ${tool} execution forbidden\\n" >&2\nexit 1\n`
      writeFileSync(targetPath, script, { mode: 0o755 })
    } else {
      const hostDirs = ['/usr/bin', '/bin']
      const hostTool = hostDirs.map((d) => join(d, tool)).find(existsSync)
      if (!hostTool) {
        throw new Error(`Required host tool not found: ${tool}`)
      }
      symlinkSync(hostTool, targetPath)
    }
  }

  function run(
    command: 'docker' | 'curl',
    args: string[],
    callEnv?: NodeJS.ProcessEnv,
  ): ProcessResult {
    appendFileSync(commandsLog, JSON.stringify({ command, args }) + '\n')
    const env = callEnv ? buildChildEnv(binDir, { ...childEnv, ...callEnv }) : childEnv
    const res = spawnSync(join(binDir, command), args, {
      cwd: opRoot,
      env,
      timeout: 10000,
      encoding: 'utf8',
    })
    return {
      status: res.status,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
    }
  }

  return {
    dir: sandbox.dir,
    binDir,
    opRoot,
    commandsLog,
    childEnv,
    runDocker: (args, env) => run('docker', args, env),
    runCurl: (args, env) => run('curl', args, env),
    cleanup: () => sandbox.cleanup(),
  }
}

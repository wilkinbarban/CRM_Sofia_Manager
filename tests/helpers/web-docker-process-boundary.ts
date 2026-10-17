/**
 * Hermetic process and filesystem boundary helper for Docker/curl operations.
 * Reuses web-private-sandbox for 0700 root, closed 19-tool binDir, NDJSON logging,
 * and whitelist-only child environment isolation.
 */
import { appendFileSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ModuleKind, transpileModule } from 'typescript'
import { createPrivateSandbox } from './web-private-sandbox'
import {
  FIXTURE_INITIAL_IMAGE_ID,
  FIXTURE_INITIAL_CONFIG_IMAGE,
} from './web-docker-dispatcher'

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
  readonly childEnv: Readonly<Record<string, string> & { NODE_ENV: 'test' }>
  runDocker: (args: string[], ambientEnv?: NodeJS.ProcessEnv) => ProcessResult
  runCurl: (args: string[], ambientEnv?: NodeJS.ProcessEnv) => ProcessResult
  getCurrentImageId?: () => string
  getCurrentConfigImage?: () => string
  cleanup: () => void
}

export interface WebDockerProcessBoundaryHelper {
  readonly EXPECTED_TOOLS?: readonly string[]
  readonly CHILD_ENV_KEYS?: readonly string[]
  createDockerProcessBoundary: (ambientEnv?: NodeJS.ProcessEnv) => DockerProcessBoundary
}

const DISPATCHER_PATH = join(import.meta.dirname, 'web-docker-dispatcher.ts')

const dispatcherCjs = transpileModule(
  readFileSync(DISPATCHER_PATH, 'utf8'),
  { compilerOptions: { module: ModuleKind.CommonJS } },
).outputText

function buildChildEnv(
  binDir: string,
  ambient?: NodeJS.ProcessEnv,
): Record<string, string> & { NODE_ENV: 'test' } {
  const src = ambient ?? process.env
  // The child always runs as a test process: NODE_ENV is declared here rather than
  // inherited from the ambient environment, so the boundary's contract is stable.
  const env: Record<string, string> & { NODE_ENV: 'test' } = { NODE_ENV: 'test', PATH: binDir }
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
  const stateFile = join(sandbox.dir, 'docker-state.json')
  const bridgeScript = join(sandbox.dir, 'docker-bridge.cjs')

  writeFileSync(
    stateFile,
    JSON.stringify({
      currentImageId: FIXTURE_INITIAL_IMAGE_ID,
      currentConfigImage: FIXTURE_INITIAL_CONFIG_IMAGE,
    }),
  )

  const bridgeCode = `${dispatcherCjs}
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
const dispatcher = exports.createDockerDispatcher({ opRoot: ${JSON.stringify(opRoot)} });
dispatcher.setCurrentImageId(state.currentImageId);
dispatcher.setCurrentConfigImage(state.currentConfigImage);
const res = dispatcher.runDocker(process.argv.slice(2));
fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify({
  currentImageId: dispatcher.getCurrentImageId(),
  currentConfigImage: dispatcher.getCurrentConfigImage(),
}));
if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write(res.stderr);
process.exit(res.status);
`
  writeFileSync(bridgeScript, bridgeCode)

  for (const tool of EXPECTED_TOOLS) {
    const targetPath = join(binDir, tool)
    if (tool === 'docker') {
      const script = `#!/bin/sh\nexec "${process.execPath}" -- "${bridgeScript}" "$@"\n`
      writeFileSync(targetPath, script, { mode: 0o755 })
    } else if (tool === 'curl') {
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

  const readState = () =>
    JSON.parse(readFileSync(stateFile, 'utf8')) as {
      currentImageId: string
      currentConfigImage: string
    }

  return {
    dir: sandbox.dir,
    binDir,
    opRoot,
    commandsLog,
    childEnv,
    runDocker: (args, env) => run('docker', args, env),
    runCurl: (args, env) => run('curl', args, env),
    getCurrentImageId: () => readState().currentImageId,
    getCurrentConfigImage: () => readState().currentConfigImage,
    cleanup: () => sandbox.cleanup(),
  }
}

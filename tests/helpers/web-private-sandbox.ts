/**
 * Standalone private test sandbox and hermetic Python runner.
 * Node sequential, isolated single-user environment.
 * NOT atomic dirfd, NOT race-proof. Raw outputs only for trusted test scope.
 */
import {
  mkdtempSync, rmSync, chmodSync, existsSync, mkdirSync, statSync, lstatSync, realpathSync,
} from 'node:fs'
import { join, isAbsolute, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

export const PYTHON_BIN = '/usr/bin/python3'

export interface RunPythonResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

export interface RunPythonOptions {
  extraEnv?: Record<string, string>
  args?: string[]
  cwd?: string
  timeout?: number
}

export interface PrivateSandbox {
  dir: string
  rootDev: number
  rootIno: number
  subdirs: string[]
  mkdir: (name: string, mode?: number) => string
  runPython: (code: string, options?: RunPythonOptions) => RunPythonResult
  cleanup: () => void
}

export function runHermeticPython(code: string, options: RunPythonOptions = {}): RunPythonResult {
  const targetCwd = options.cwd ?? process.cwd()
  let lst
  try {
    lst = lstatSync(targetCwd)
  } catch {
    throw new Error(`Target cwd does not exist: ${targetCwd}`)
  }
  if (lst.isSymbolicLink()) {
    throw new Error(`Target cwd is a symlink: ${targetCwd}`)
  }
  if (!lst.isDirectory()) {
    throw new Error(`Target cwd is not a directory: ${targetCwd}`)
  }

  const env: Record<string, string> = {
    PATH: '/usr/bin:/bin',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPATH: process.cwd(),
    ...options.extraEnv,
  }
  const pythonArgs = ['-B', '-c', code, ...(options.args || [])]
  const res = spawnSync(PYTHON_BIN, pythonArgs, {
    cwd: targetCwd,
    env,
    timeout: options.timeout ?? 20000,
    encoding: 'utf8',
  })
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    error: res.error,
  }
}

export function createPrivateSandbox(prefix = 'priv-sb-'): PrivateSandbox {
  const baseTmp = realpathSync(tmpdir())
  const dir = realpathSync(mkdtempSync(join(baseTmp, prefix)))
  chmodSync(dir, 0o700)

  const initialStat = statSync(dir)
  if ((initialStat.mode & 0o777) !== 0o700) {
    throw new Error(`Failed to initialize private 0700 sandbox: mode is 0o${(initialStat.mode & 0o777).toString(8)}`)
  }

  const ownedRoot = dir
  const rootDev = initialStat.dev
  const rootIno = initialStat.ino
  let cleaned = false
  const subdirs: string[] = []

  const validateCapturedRoot = () => {
    let lst
    try {
      lst = lstatSync(ownedRoot)
    } catch {
      throw new Error(`Sandbox root no longer exists: ${ownedRoot}`)
    }
    if (lst.isSymbolicLink()) {
      throw new Error(`Sandbox root was replaced with symlink: ${ownedRoot}`)
    }
    if (lst.dev !== rootDev || lst.ino !== rootIno) {
      throw new Error(`Sandbox root identity changed (dev/ino mismatch): ${ownedRoot}`)
    }
    if (!lst.isDirectory()) {
      throw new Error(`Sandbox root is not a directory: ${ownedRoot}`)
    }
  }

  const mkdir = (name: string, mode = 0o700): string => {
    if (cleaned) throw new Error('Sandbox already cleaned up')
    validateCapturedRoot()

    if (isAbsolute(name)) throw new Error(`Target path must be relative: ${name}`)
    if (!name || name.trim() === '') throw new Error('Target path cannot be empty')
    const rawParts = name.split(/[/\\]/)
    if (rawParts.some(p => p === '.' || p === '..')) {
      throw new Error(`Target path contains raw . or .. component (must be inside sandbox): ${name}`)
    }
    const norm = normalize(name)
    if (norm.startsWith('../') || norm === '..') {
      throw new Error(`Target path must be inside sandbox: ${name}`)
    }

    const parts = norm.split('/').filter(Boolean)
    let cur = ownedRoot
    const missing: string[] = []
    for (const part of parts) {
      cur = join(cur, part)
      let lst
      try {
        lst = lstatSync(cur)
      } catch {
        lst = null
      }
      if (lst) {
        if (lst.isSymbolicLink()) throw new Error(`Symlink component encountered: ${cur}`)
        if (!lst.isDirectory()) throw new Error(`Path component is not directory: ${cur}`)
        const real = realpathSync(cur)
        if (!real.startsWith(ownedRoot + '/') && real !== ownedRoot) {
          throw new Error(`Path component escapes root: ${cur}`)
        }
      } else {
        missing.push(cur)
      }
    }
    for (const missingPath of missing) {
      mkdirSync(missingPath, { mode })
      chmodSync(missingPath, mode)
    }
    subdirs.push(cur)
    return cur
  }

  const sandbox: PrivateSandbox = {
    dir: ownedRoot,
    rootDev,
    rootIno,
    subdirs,
    mkdir,
    runPython(this: PrivateSandbox | void, code: string, options?: RunPythonOptions): RunPythonResult {
      if (!this || this.dir !== ownedRoot) {
        throw new Error(`Refusing runPython: public dir does not match captured root: ${this?.dir} !== ${ownedRoot}`)
      }
      if (cleaned) throw new Error('Sandbox already cleaned up')
      validateCapturedRoot()
      if (options?.cwd && options.cwd !== ownedRoot) {
        throw new Error(`Sandbox runner cwd must be owned root only: ${options.cwd} !== ${ownedRoot}`)
      }
      return runHermeticPython(code, { ...options, cwd: ownedRoot })
    },
    cleanup(this: PrivateSandbox | void) {
      if (!this || this.dir !== ownedRoot) {
        throw new Error(`Refusing cleanup: public dir does not match captured root: ${this?.dir} !== ${ownedRoot}`)
      }
      if (cleaned) return
      let lst
      try {
        lst = lstatSync(ownedRoot)
      } catch {
        cleaned = true
        return
      }
      if (lst.isSymbolicLink()) {
        throw new Error(`Refusing to remove symlinked root: ${ownedRoot}`)
      }
      if (lst.dev !== rootDev || lst.ino !== rootIno) {
        throw new Error(`Refusing to remove replaced root: ${ownedRoot}`)
      }
      const realRoot = realpathSync(ownedRoot)
      const realBase = realpathSync(baseTmp)
      if (!realRoot.startsWith(realBase + '/') || realRoot === realBase) {
        throw new Error(`Refusing to remove path outside owned temp: ${ownedRoot}`)
      }
      cleaned = true
      rmSync(ownedRoot, { recursive: true, force: true })
    },
  }

  return sandbox
}


/**
 * Tests for web-private-sandbox: Node sequential isolated single-user environment.
 * NOT atomic dirfd, NOT race-proof. Raw outputs only for trusted test scope.
 */
import { describe, expect, it, afterEach } from 'vitest'
import {
  existsSync, statSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, renameSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createPrivateSandbox, runHermeticPython, type PrivateSandbox,
} from '../helpers/web-private-sandbox'

let sb: PrivateSandbox | null = null

afterEach(() => {
  if (sb) {
    sb.cleanup()
    sb = null
  }
})

describe('web-private-sandbox standalone private sandbox lifecycle and hermetic runner', () => {
  it('enforces private 0700 permissions on sandbox and created subdirectories', () => {
    sb = createPrivateSandbox()
    expect(existsSync(sb.dir)).toBe(true)
    const sbStat = statSync(sb.dir)
    expect(sbStat.mode & 0o777).toBe(0o700)

    const sub = sb.mkdir('deploy')
    expect(existsSync(sub)).toBe(true)
    const subStat = statSync(sub)
    expect(subStat.mode & 0o777).toBe(0o700)
    expect(sb.subdirs).toContain(sub)
  })

  it('performs lifecycle cleanup confined to owned temp and is idempotent', () => {
    sb = createPrivateSandbox()
    const dir = sb.dir
    expect(existsSync(dir)).toBe(true)

    sb.cleanup()
    expect(existsSync(dir)).toBe(false)

    expect(() => sb?.cleanup()).not.toThrow()
    sb = null
  })

  it('rejects traversal outside sandbox in mkdir and disallows absolute paths', () => {
    sb = createPrivateSandbox()
    expect(() => sb!.mkdir('../escape')).toThrow(/inside sandbox/i)
    expect(() => sb!.mkdir('nested/../../escape')).toThrow(/inside sandbox/i)
    expect(() => sb!.mkdir('/absolute/target')).toThrow(/relative/i)

    expect(() => sb!.mkdir('a/../b')).toThrow(/raw \. or \.\./i)
    expect(existsSync(join(sb.dir, 'a'))).toBe(false)
    expect(() => sb!.mkdir('a/./b')).toThrow(/raw \. or \.\./i)
    expect(existsSync(join(sb.dir, 'a'))).toBe(false)
    expect(() => sb!.mkdir('.')).toThrow(/raw \. or \.\./i)
    expect(() => sb!.mkdir('..')).toThrow(/raw \. or \.\./i)
  })

  it('spawns hermetic python without ambient credential or environment leaks', () => {
    sb = createPrivateSandbox()
    const ambientKey = 'AMBIENT_TEST_SECRET_' + Date.now()
    process.env[ambientKey] = 'super-secret-token'

    try {
      const res = sb.runPython(`import os\nprint(os.environ.get("${ambientKey}", "NOT_FOUND"))`)
      expect(res.status).toBe(0)
      expect(res.stdout.trim()).toBe('NOT_FOUND')

      const standalone = runHermeticPython(`import os\nprint(os.environ.get("${ambientKey}", "NOT_FOUND"))`)
      expect(standalone.status).toBe(0)
      expect(standalone.stdout.trim()).toBe('NOT_FOUND')
    } finally {
      delete process.env[ambientKey]
    }
  })

  it('propagates spawn failure status and raw error output', () => {
    sb = createPrivateSandbox()
    const failRes = sb.runPython('import sys\nsys.stderr.write("controlled failure\\n")\nsys.exit(42)')
    expect(failRes.status).toBe(42)
    expect(failRes.stderr).toBe('controlled failure\n')

    const errRes = sb.runPython('raise ValueError("simulated invalid arg")')
    expect(errRes.status).toBe(1)
    expect(errRes.stderr).toContain('ValueError: simulated invalid arg')

    const rawRes = sb.runPython('import sys\nsys.stdout.write("hello raw\\n"); sys.stderr.write("warn raw\\n")')
    expect(rawRes.stdout).toBe('hello raw\n')
    expect(rawRes.stderr).toBe('warn raw\n')

    const timeoutRes = sb.runPython('import time\ntime.sleep(5)', { timeout: 100 })
    expect(timeoutRes.error).toBeDefined()
    expect((timeoutRes.error as any)?.code === 'ETIMEDOUT' || timeoutRes.status === null).toBe(true)
  })

  it('validates target cwd exists and is directory before spawn', () => {
    sb = createPrivateSandbox()
    expect(() => runHermeticPython('print(1)', { cwd: join(tmpdir(), 'missing-' + Date.now()) })).toThrow(/cwd does not exist/i)

    const file = join(sb.dir, 'regular-file.txt')
    writeFileSync(file, 'test')
    expect(() => runHermeticPython('print(1)', { cwd: file })).toThrow(/not a directory/i)

    expect(() => sb!.runPython('print(1)', { cwd: tmpdir() })).toThrow(/owned root only/i)
    const sym = join(tmpdir(), 'sb-sym-cwd-' + Date.now())
    symlinkSync(sb.dir, sym)
    try {
      expect(() => runHermeticPython('print(1)', { cwd: sym })).toThrow(/symlink/i)
    } finally {
      rmSync(sym, { force: true })
    }
  })

  it('rejects mutable this.dir redirect on cleanup preserving /tmp and sibling directories', () => {
    sb = createPrivateSandbox()
    const ownedDir = sb.dir
    const sibling = mkdtempSync(join(tmpdir(), 'priv-sb-sibling-'))
    const marker = join(sibling, 'keep.txt')
    writeFileSync(marker, 'preserve')

    try {
      const hijackedSibling = { ...sb, dir: sibling }
      expect(() => hijackedSibling.cleanup()).toThrow(/does not match captured root/i)
      expect(existsSync(marker)).toBe(true)
      expect(existsSync(sibling)).toBe(true)

      const hijackedTmp = { ...sb, dir: tmpdir() }
      expect(() => hijackedTmp.cleanup()).toThrow(/does not match captured root/i)
      expect(() => hijackedTmp.runPython('print(1)')).toThrow(/does not match captured root/i)
      expect(existsSync(ownedDir)).toBe(true)
    } finally {
      if (existsSync(sibling)) rmSync(sibling, { recursive: true, force: true })
    }
  })

  it('fails closed on root rename and replacement directory preserving marker on mkdir and cleanup', () => {
    sb = createPrivateSandbox()
    const orig = sb.dir
    const backup = orig + '-bak'
    renameSync(orig, backup)
    mkdirSync(orig, { mode: 0o700 })
    const marker = join(orig, 'marker.txt')
    writeFileSync(marker, 'preserve-me')

    try {
      expect(() => sb!.mkdir('child')).toThrow(/identity changed/i)
      expect(existsSync(marker)).toBe(true)
      expect(existsSync(join(orig, 'child'))).toBe(false)

      expect(() => sb!.runPython('print(1)')).toThrow(/identity changed/i)

      expect(() => sb!.cleanup()).toThrow(/replaced root/i)
      expect(existsSync(marker)).toBe(true)
      expect(existsSync(orig)).toBe(true)
    } finally {
      rmSync(orig, { recursive: true, force: true })
      rmSync(backup, { recursive: true, force: true })
      sb = null
    }
  })

  it('fails closed on root symlink replacement on mkdir and cleanup', () => {
    sb = createPrivateSandbox()
    const orig = sb.dir
    const backup = orig + '-bak'
    renameSync(orig, backup)
    symlinkSync(backup, orig)

    try {
      expect(() => sb!.mkdir('child')).toThrow(/symlink/i)
      expect(() => sb!.cleanup()).toThrow(/symlink/i)
      expect(existsSync(backup)).toBe(true)
    } finally {
      rmSync(orig, { force: true })
      rmSync(backup, { recursive: true, force: true })
      sb = null
    }
  })

  it('rejects symlink intermediates and leaf symlinks in mkdir preserving outside markers', () => {
    sb = createPrivateSandbox()
    const outside = mkdtempSync(join(tmpdir(), 'priv-outside-'))
    const marker = join(outside, 'marker.txt')
    writeFileSync(marker, 'safe')

    try {
      symlinkSync(outside, join(sb.dir, 'sym-dir'))
      expect(() => sb!.mkdir('sym-dir/child')).toThrow(/symlink/i)
      expect(() => sb!.mkdir('sym-dir')).toThrow(/symlink/i)
      expect(existsSync(marker)).toBe(true)
      expect(existsSync(join(outside, 'child'))).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('handles symlinked TMPDIR canonicalizing owned root on nested mkdir', () => {
    const origTmp = process.env.TMPDIR
    const realTmp = mkdtempSync(join(tmpdir(), 'real-tmp-'))
    const aliasTmp = join(tmpdir(), 'alias-tmp-' + Date.now())
    symlinkSync(realTmp, aliasTmp)
    let testSb: PrivateSandbox | null = null
    try {
      process.env.TMPDIR = aliasTmp
      testSb = createPrivateSandbox()
      testSb.mkdir('nested')
      const child = testSb.mkdir('nested/child')
      expect(existsSync(child)).toBe(true)
      expect(child.startsWith(testSb.dir)).toBe(true)
    } finally {
      if (origTmp === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = origTmp
      if (testSb) testSb.cleanup()
      rmSync(aliasTmp, { force: true })
      rmSync(realTmp, { recursive: true, force: true })
    }
    expect(process.env.TMPDIR).toBe(origTmp)
  })
})

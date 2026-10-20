import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const root = process.cwd()
const probe = join(root, 'scripts/verify-webhook-ingress-limit.sh')
const bytesVar = 'ASADOS_WEBHOOK_INGRESS_LIMIT_BYTES'
const timeoutVar = 'ASADOS_WEBHOOK_INGRESS_LIMIT_TIMEOUT_SECONDS'

// Issue #196 / slice 4: the probe must fail closed on invalid arguments and must
// never misreport malformed `curl --write-out` output as an ingress verdict.
const servers: Server[] = []
const shimDirs: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close))
  for (const dir of shimDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function close(server: Server) {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

/** Records every request it sees and answers 413, so an early exit leaves it empty. */
async function recordingStub(): Promise<{ baseUrl: string; observed: string[]; lengths: string[] }> {
  const observed: string[] = []
  const lengths: string[] = []
  const server = createServer((request, response) => {
    observed.push(`${request.method} ${request.url}`)
    lengths.push(request.headers['content-length'] ?? '')
    request.resume()
    response.statusCode = 413
    response.end()
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('stub did not bind a TCP port')
  return { baseUrl: `http://127.0.0.1:${address.port}`, observed, lengths }
}

/** Puts a fake `curl` first on PATH and returns the directory holding it. */
function curlShim(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ingress-limit-shim-'))
  shimDirs.push(dir)
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 })
  return dir
}

function runProbe(
  args: string[],
  env: Partial<NodeJS.ProcessEnv> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(probe, args, { cwd: root, env: { ...process.env, ...env } })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const code = new Promise<number | null>((resolve) => {
    child.on('error', (error) => { stderr += `${error.message}\n`; resolve(null) })
    child.on('exit', (exitCode) => resolve(exitCode))
  })
  return code.then((exitCode) => ({ code: exitCode, stdout, stderr }))
}

describe('ingress limit probe argument validation', () => {
  it.each(['abc', '0', '-5', '1.5', ' 42', '12abc'])(
    'rejects the oversized byte override %j without hitting the network',
    async (value) => {
      const { baseUrl, observed } = await recordingStub()

      const result = await runProbe([baseUrl], { [bytesVar]: value })

      expect(result.code).toBe(2)
      expect(result.stderr).toContain(bytesVar)
      expect(result.stderr).toContain('positive integer')
      expect(observed).toEqual([])
    },
  )

  it('treats an empty byte override as unset and keeps the documented default', async () => {
    const { baseUrl, observed, lengths } = await recordingStub()

    const result = await runProbe([baseUrl], { [bytesVar]: '' })

    expect(result.code).toBe(0)
    expect(observed).toEqual(['POST /api/webhooks/evolution'])
    expect(lengths).toEqual(['11534336'])
  })

  it.each(['abc', '0', '-1', '1.5'])(
    'rejects the timeout override %j without hitting the network',
    async (value) => {
      const { baseUrl, observed } = await recordingStub()

      const result = await runProbe([baseUrl], { [timeoutVar]: value })

      expect(result.code).toBe(2)
      expect(result.stderr).toContain(timeoutVar)
      expect(result.stderr).toContain('positive integer')
      expect(observed).toEqual([])
    },
  )

  it.each(['abc', '20', '4130', '413 ', '4e2'])(
    'rejects the expected code %j as an argument error instead of an ingress failure',
    async (value) => {
      const { baseUrl, observed } = await recordingStub()

      const result = await runProbe([baseUrl, value])

      expect(result.code).toBe(2)
      expect(result.stderr).toContain('expected-code')
      expect(result.stderr).not.toContain('was not rejected')
      expect(observed).toEqual([])
    },
  )

  it.each(['example.com', 'ftp://example.com', 'http://', 'http:/example.com', '//example.com'])(
    'rejects the base URL %j before any request',
    async (value) => {
      const { observed } = await recordingStub()

      const result = await runProbe([value])

      expect(result.code).toBe(2)
      expect(result.stderr).toContain('base-url')
      expect(observed).toEqual([])
    },
  )
})

describe('ingress limit probe curl output parsing', () => {
  it('reports an unparseable curl result instead of blaming the ingress', async () => {
    const shim = curlShim("printf 'garbage'")
    const result = await runProbe(['http://127.0.0.1:1'], { PATH: `${shim}:${process.env.PATH ?? ''}` })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('unparseable')
    expect(result.stderr).toContain('garbage')
    expect(result.stderr).not.toContain('uploaded garbage bytes')
    expect(result.stderr).not.toContain('was not rejected')
    expect(result.stdout).toBe('')
  })

  it('reports an empty curl result as unparseable', async () => {
    const shim = curlShim('exit 0')
    const result = await runProbe(['http://127.0.0.1:1'], { PATH: `${shim}:${process.env.PATH ?? ''}` })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('unparseable')
  })

  it('keeps a transport code parseable and diagnoses it as a missing rejection', async () => {
    const shim = curlShim("printf '000 0'")
    const result = await runProbe(['http://127.0.0.1:1'], { PATH: `${shim}:${process.env.PATH ?? ''}` })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('was not rejected')
    expect(result.stderr).toContain('observed 000')
    expect(result.stderr).not.toContain('unparseable')
  })

  it('still reports an unexpected successful code as an ingress verdict', async () => {
    const shim = curlShim("printf '200 0'")
    const result = await runProbe(['http://127.0.0.1:1'], { PATH: `${shim}:${process.env.PATH ?? ''}` })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('observed 200')
    expect(result.stderr).toContain('413')
  })
})

describe('ingress limit probe static checks', () => {
  it('passes bash syntax validation', () => {
    const result = spawnSync('bash', ['-n', probe], { encoding: 'utf8' })

    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  const shellcheck = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' })
  it.skipIf(shellcheck.status !== 0)('passes shellcheck when the binary is available', () => {
    const result = spawnSync('shellcheck', [probe], { encoding: 'utf8' })

    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })
})

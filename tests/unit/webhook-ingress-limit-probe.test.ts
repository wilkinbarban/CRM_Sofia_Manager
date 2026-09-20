import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const root = process.cwd()
const probe = join(root, 'scripts/verify-webhook-ingress-limit.sh')
const defaultPayloadBytes = 11_534_336
const overridePayloadBytes = 4_194_304

type ObservedRequest = {
  path: string
  contentLength: string | undefined
  bodyBytes: number
}

type ProbeResult = {
  code: number | null
  stdout: string
  stderr: string
}

const children: ReturnType<typeof spawn>[] = []
const servers: Server[] = []

afterEach(async () => {
  children.splice(0).forEach((child) => child.kill('SIGKILL'))
  await Promise.all(servers.splice(0).map((server) => closeStub(server)))
})

function createStub(status: number) {
  const observed: ObservedRequest[] = []
  // The stub counts the body bytes it actually receives. It answers `100
  // Continue` and holds the answer back, so a probe that had a body to send
  // would really send it and the count would show it.
  const handle = (request: IncomingMessage, response: ServerResponse) => {
    const entry: ObservedRequest = {
      path: request.url ?? '',
      contentLength: request.headers['content-length'],
      bodyBytes: 0,
    }
    observed.push(entry)
    request.on('data', (chunk: Buffer) => { entry.bodyBytes += chunk.length })
    response.writeContinue()
    response.statusCode = status
    setTimeout(() => response.end(), 300)
  }

  const server = createServer()
  server.on('request', handle)
  // Requests carrying `Expect: 100-continue` reach this listener instead.
  server.on('checkContinue', handle)
  return { server, observed }
}

async function closeStub(server: Server) {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function withStub<T>(
  status: number,
  run: (baseUrl: string, observed: ObservedRequest[]) => Promise<T>,
): Promise<T> {
  const { server, observed } = createStub(status)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('stub did not bind a TCP port')

  try {
    return await run(`http://127.0.0.1:${address.port}`, observed)
  } finally {
    await closeStub(server)
  }
}

async function runProbe(args: string[], env: Partial<NodeJS.ProcessEnv> = {}): Promise<ProbeResult> {
  const child = spawn(probe, args, { cwd: root, env: { ...process.env, ...env } })
  children.push(child)

  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })

  const code = await new Promise<number | null>((resolve) => {
    child.on('error', (error) => {
      stderr += `${error.message}\n`
      resolve(null)
    })
    child.on('exit', (exitCode) => resolve(exitCode))
  })

  return { code, stdout, stderr }
}

describe('Evolution webhook ingress body limit probe', () => {
  it('declares an oversized length, sends no body, and accepts the 413', async () => {
    await withStub(413, async (baseUrl, observed) => {
      const result = await runProbe([baseUrl])

      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('413')
      expect(observed).toEqual([
        {
          path: '/api/webhooks/evolution',
          contentLength: String(defaultPayloadBytes),
          bodyBytes: 0,
        },
      ])
    })
  })

  it('sends no body bytes even when the ingress invites the upload', async () => {
    // Regression guard: the previous design uploaded the full 11 MiB here.
    await withStub(413, async (baseUrl, observed) => {
      const result = await runProbe([baseUrl])

      expect(result.code).toBe(0)
      expect(observed[0]?.bodyBytes).toBe(0)
    })
  })

  it('fails and names the observed code when the ingress accepts the oversized payload', async () => {
    await withStub(200, async (baseUrl, observed) => {
      const result = await runProbe([baseUrl])

      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain('200')
      expect(result.stderr).toContain('413')
      expect(observed[0]?.bodyBytes).toBe(0)
    })
  })

  it('uses the configured oversized payload size', async () => {
    await withStub(413, async (baseUrl, observed) => {
      const result = await runProbe([baseUrl], {
        ASADOS_WEBHOOK_INGRESS_LIMIT_BYTES: String(overridePayloadBytes),
      })

      expect(result.code).toBe(0)
      expect(observed[0]?.contentLength).toBe(String(overridePayloadBytes))
      expect(observed[0]?.bodyBytes).toBe(0)
    })
  })

  it('fails loudly when no base URL is given', async () => {
    const result = await runProbe([])

    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/usage/i)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { Worker } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { copyFile, mkdtemp, readFile, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import { DEEPSEEK_DEFAULT_MODEL } from '@/lib/ai/deepseek'
import { processPaymentProofJob, renderPaymentProofWithWorker } from '@/lib/payment-proofs/processing-worker'

const PDF = new Uint8Array([0x25,0x50,0x44,0x46,0x2d,0x31])
const PNG = new Uint8Array([1,2,3])
const standaloneNodeModules = path.resolve('apps/web/.next/standalone/node_modules')
const rootNodeModules = path.resolve('node_modules')

function resolveWorkerNodeModules(options: {
  standalonePath?: string
  rootPath?: string
  exists?: (targetPath: string) => boolean
} = {}): string {
  const standalone = options.standalonePath ?? standaloneNodeModules
  const root = options.rootPath ?? rootNodeModules
  const exists = options.exists ?? existsSync
  return exists(standalone) ? standalone : root
}

function renderablePdf(width = 20, height = 20, content = '') {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << >> /Contents 4 0 R >>`,`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`]
  let body='%PDF-1.4\n';const offsets=[0]
  objects.forEach((object,index)=>{offsets[index+1]=Buffer.byteLength(body);body+=`${index+1} 0 obj\n${object}\nendobj\n`})
  const xref=Buffer.byteLength(body);body+=`xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(value=>`${String(value).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return new Uint8Array(Buffer.from(body))
}

function db(options: { preview?: string | null; advisory?: boolean; mimeType?: string; bytes?: Uint8Array } = {}) {
  const rpc = vi.fn(async () => ({ data: true, error: null }))
  const from = vi.fn((table: string) => {
    const builder: any = {
      select: vi.fn(() => builder), eq: vi.fn(() => builder), limit: vi.fn(() => builder),
      maybeSingle: vi.fn(async () => table === 'payment_proof_advisory_attempts'
        ? { data: options.advisory ? { proof_id: 'proof-1' } : null, error: null }
        : { data: { id: 'proof-1', status: 'received', channel: 'telegram', original_storage_key: 'proofs/private/telegram/a.pdf', preview_storage_key: options.preview ?? null, sha256: 'a'.repeat(64), mime_type: options.mimeType ?? 'application/pdf' }, error: null }),
    }
    return builder
  })
  const upload = vi.fn(async () => ({ error: null }))
  const download = vi.fn(async () => ({ data: new Blob([Buffer.from(options.bytes ?? PDF)]), error: null }))
  return { client: { rpc, from, storage: { from: vi.fn(() => ({ upload, download })) } }, rpc, upload, download }
}

const render = vi.fn(async () => ({ png: PNG, sha256: 'b'.repeat(64), width: 10, height: 20, version: 'test' }))
const classify = vi.fn(async (input: any) => { await input.persist({ disposition:'manual_review', likelyPaymentProof:true, confidence:0.5, suggestedAmountCents:null, reasonCode:'low_signal', model:'test' }); return { reasonCode:'low_signal' } })

describe('payment-proof processing worker', () => {
  it('resumes each durable stage without duplicating completed render/advisory events', async () => {
    for (const state of [{}, { preview:'proofs/private/telegram/a.png' }, { preview:'proofs/private/telegram/a.png', advisory:true }]) {
      render.mockClear(); classify.mockClear()
      const { client, rpc, upload } = db(state)
      const result = await processPaymentProofJob({ proofId:'proof-1', db:client as any, apiKey:'', model:'test', render, classify:classify as any })
      expect(result).toEqual({ ok:true })
      expect(render).toHaveBeenCalledTimes(state.preview ? 0 : 1)
      expect(upload).toHaveBeenCalledTimes(state.preview ? 0 : 1)
      if (!state.preview) {
        const [previewKey, previewBody, previewOptions] = (upload.mock.calls as unknown[][])[0] ?? []
        expect(previewKey).toMatch(/^proofs\/private\/[a-f0-9]{64}\.png$/)
        expect(Buffer.isBuffer(previewBody)).toBe(true)
        expect(previewBody).toEqual(Buffer.from(PNG))
        expect(previewOptions).toEqual({ contentType:'image/png', upsert:true })
      }
      expect(classify).toHaveBeenCalledTimes(state.advisory ? 0 : 1)
      if (!state.advisory) expect(classify).toHaveBeenCalledWith(expect.objectContaining({ extractedText: expect.any(String) }))
      expect((rpc.mock.calls as unknown[][]).filter(([name]) => name === 'record_payment_proof_render')).toHaveLength(state.preview ? 0 : 1)
      expect((rpc.mock.calls as unknown[][]).filter(([name]) => name === 'record_payment_proof_advisory')).toHaveLength(state.advisory ? 0 : 1)
    }
  })

  it('uses canonical image bytes as preview and visual advisory input without PDF rendering or parsing', async () => {
    render.mockClear()
    const image = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1])
    const { client, upload } = db({ mimeType:'image/png', bytes:image })
    const imageClassify = vi.fn(async (input: any) => { await input.persist({ disposition:'manual_review', likelyPaymentProof:true, confidence:0.9, suggestedAmountCents:123, reasonCode:'payment_markers_present', model:'test' }) })
    const result = await processPaymentProofJob({ proofId:'proof-1', db:client as any, render, classify:imageClassify as any })
    expect(result).toEqual({ ok:true })
    expect(render).not.toHaveBeenCalled()
    expect(upload).toHaveBeenCalledWith(expect.any(String), Buffer.from(image), expect.any(Object))
    expect(imageClassify).toHaveBeenCalledWith(expect.objectContaining({ extractedText:'', imageDataUrl:`data:image/png;base64,${Buffer.from(image).toString('base64')}` }))
  })

  it('defaults the classifier to the DeepSeek model and lets the boundary own the retry', async () => {
    render.mockClear()
    const { client } = db()
    const classifySpy = vi.fn(async (input: any) => {
      await input.persist({ disposition:'manual_review', likelyPaymentProof:null, confidence:null, suggestedAmountCents:null, reasonCode:'low_signal', model:input.model })
    })

    const result = await processPaymentProofJob({ proofId:'proof-1', db:client as any, render, classify:classifySpy as any })

    expect(result).toEqual({ ok:true })
    expect(classifySpy).toHaveBeenCalledTimes(1)
    const call = classifySpy.mock.calls[0][0] as Record<string, unknown>
    expect(call.model).toBe(DEEPSEEK_DEFAULT_MODEL)
    expect(call).not.toHaveProperty('maxAttempts')
  })

  it('maps an original blob read exception to the fixed load stage instead of throwing', async () => {
    const { client } = db()
    client.storage.from = vi.fn(() => ({
      upload: vi.fn(async () => ({ error: null })),
      download: vi.fn(async () => ({
        data: new Blob([PDF], { type: 'application/pdf' }),
        error: { message: 'private blob detail' },
      })),
    })) as unknown as typeof client.storage.from

    await expect(processPaymentProofJob({ proofId:'proof-1', db:client as any, render, classify:classify as any }))
      .resolves.toEqual({ ok:false, stage:'load' })
  })

  it.each([
    ['render', vi.fn(async () => { throw new Error('private render detail') }), classify],
    ['classifier', render, vi.fn(async () => { throw new Error('private classifier detail') })],
  ] as const)('keeps worker-owned %s failures sanitized and stage-specific', async (stage, stageRender, stageClassify) => {
    const { client } = db()

    await expect(processPaymentProofJob({ proofId:'proof-1', db:client as any, render:stageRender, classify:stageClassify as any }))
      .resolves.toEqual({ ok:false, stage })
  })

  it('keeps the production worker runner outside webpack URL transformation', async () => {
    const [source, dockerfile] = await Promise.all([
      readFile('apps/web/src/lib/payment-proofs/processing-worker.ts', 'utf8'),
      readFile('Dockerfile', 'utf8'),
    ])
    expect(source).toContain("pathToFileURL('/app/payment-proof-render-worker.mjs')")
    expect(source).not.toContain("new URL('file:///app/apps/web/src/lib/payment-proofs/render-worker.mjs')")
    expect(dockerfile).toContain('/app/payment-proof-render-worker.mjs')
  })

  it('starts the real dedicated ESM worker file and renders a PDF', async () => {
    const bytes = renderablePdf()
    const result = await renderPaymentProofWithWorker(bytes, 20_000, () => new Worker(
      path.resolve('apps/web/src/lib/payment-proofs/render-worker.mjs'),
      { workerData: { bytes: bytes.slice().buffer } },
    ))
    expect(result.png.subarray(0, 8)).toEqual(Uint8Array.from([137,80,78,71,13,10,26,10]))
  })

  it('prefers standalone dependencies when present and falls back to root node_modules', () => {
    const customStandalone = '/custom/standalone/node_modules'
    const customRoot = '/custom/node_modules'

    expect(resolveWorkerNodeModules({
      standalonePath: customStandalone,
      rootPath: customRoot,
      exists: (target) => target === customStandalone,
    })).toBe(customStandalone)

    expect(resolveWorkerNodeModules({
      standalonePath: customStandalone,
      rootPath: customRoot,
      exists: (target) => target === customRoot,
    })).toBe(customRoot)

    expect(resolveWorkerNodeModules({
      standalonePath: customStandalone,
      rootPath: customRoot,
      exists: () => false,
    })).toBe(customRoot)

    expect(resolveWorkerNodeModules()).toBe(
      existsSync(standaloneNodeModules) ? standaloneNodeModules : rootNodeModules,
    )
  })

  it('renders from an isolated production-like root with standalone dependencies', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asados-payment-proof-processing-'))
    const workerPath = path.join(root, 'payment-proof-render-worker.mjs')
    await copyFile('apps/web/src/lib/payment-proofs/render-worker.mjs', workerPath)
    await symlink(resolveWorkerNodeModules(), path.join(root, 'node_modules'), 'dir')
    const bytes = renderablePdf()

    const result = await renderPaymentProofWithWorker(bytes, 20_000, () => new Worker(
      workerPath,
      { workerData: { bytes: bytes.slice().buffer } },
    ))

    expect(result.png.subarray(0, 8)).toEqual(Uint8Array.from([137,80,78,71,13,10,26,10]))
  })

  it('renders from an isolated production-like root with fallback root node_modules', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asados-payment-proof-processing-'))
    const workerPath = path.join(root, 'payment-proof-render-worker.mjs')
    await copyFile('apps/web/src/lib/payment-proofs/render-worker.mjs', workerPath)
    await symlink(resolveWorkerNodeModules({ exists: () => false }), path.join(root, 'node_modules'), 'dir')
    const bytes = renderablePdf()

    const result = await renderPaymentProofWithWorker(bytes, 20_000, () => new Worker(
      workerPath,
      { workerData: { bytes: bytes.slice().buffer } },
    ))

    expect(result.png.subarray(0, 8)).toEqual(Uint8Array.from([137,80,78,71,13,10,26,10]))
  })

  it('renders vector transforms through the isolated production-like worker', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asados-payment-proof-processing-'))
    const workerPath = path.join(root, 'payment-proof-render-worker.mjs')
    await copyFile('apps/web/src/lib/payment-proofs/render-worker.mjs', workerPath)
    await symlink(resolveWorkerNodeModules(), path.join(root, 'node_modules'), 'dir')
    const bytes = renderablePdf(100, 100, 'q 0.707 0.707 -0.707 0.707 50 5 cm 1 0 0 rg 0 0 40 40 re f Q')

    const result = await renderPaymentProofWithWorker(bytes, 20_000, () => new Worker(
      workerPath,
      { workerData: { bytes: bytes.slice().buffer } },
    ))

    expect(result.png.subarray(0, 8)).toEqual(Uint8Array.from([137,80,78,71,13,10,26,10]))
    expect(result.width).toBeGreaterThan(0)
    expect(result.height).toBeGreaterThan(0)
  })

  it('returns integral PNG artifact dimensions from the isolated real worker', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asados-payment-proof-processing-'))
    const workerPath = path.join(root, 'payment-proof-render-worker.mjs')
    await copyFile('apps/web/src/lib/payment-proofs/render-worker.mjs', workerPath)
    await symlink(resolveWorkerNodeModules(), path.join(root, 'node_modules'), 'dir')
    const bytes = renderablePdf(816, 1056)

    const result = await renderPaymentProofWithWorker(bytes, 20_000, () => new Worker(
      workerPath,
      { workerData: { bytes: bytes.slice().buffer } },
    ))

    expect(Number.isInteger(result.width)).toBe(true)
    expect(Number.isInteger(result.height)).toBe(true)
    expect(result.width).toBeLessThanOrEqual(1200)
    expect(result.height).toBeLessThanOrEqual(4800)
    expect(result.png.subarray(0, 8)).toEqual(Uint8Array.from([137,80,78,71,13,10,26,10]))
    expect(result.sha256).toBe(createHash('sha256').update(result.png).digest('hex'))
  })

  it('terminates a renderer that exceeds the hard wall timeout and absorbs termination rejection', async () => {
    const terminate = vi.fn(async () => { throw new Error('terminate failed') })
    const removeAllListeners = vi.fn()
    const worker: any = { once: vi.fn(), terminate, removeAllListeners }
    await expect(renderPaymentProofWithWorker(PDF, 5, () => worker)).rejects.toThrow('PAYMENT_PROOF_RENDER_TIMEOUT')
    expect(terminate).toHaveBeenCalledOnce()
    expect(removeAllListeners).toHaveBeenCalledOnce()
  })

  it('reports only fixed diagnostic categories while preserving sanitized failures', async () => {
    const diagnostics: string[] = []
    const handlers = new Map<string, (...args: any[]) => void>()
    const worker: any = {
      once: vi.fn((event, handler) => { handlers.set(event, handler); return worker }),
      on: vi.fn((event, handler) => { handlers.set(event, handler); return worker }),
      terminate: vi.fn(async () => 0),
      removeAllListeners: vi.fn(),
    }
    const promise = renderPaymentProofWithWorker(PDF, 100, () => worker, (stage) => diagnostics.push(stage))
    handlers.get('message')?.({ diagnostic: 'dependency_load' })
    handlers.get('message')?.({ ok: false, diagnostic: 'pdf_open', ignored: '/sensitive/path' })
    await expect(promise).rejects.toThrow('PAYMENT_PROOF_RENDER_FAILED')
    expect(diagnostics).toEqual(['worker_start', 'dependency_load', 'pdf_open'])
    expect(diagnostics.join(' ')).not.toContain('/')
  })
})

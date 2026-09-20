'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  X,
  Download,
  ExternalLink,
  Printer,
  FileText,
  Image as ImageIcon,
  Loader2,
  AlertTriangle,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  CheckCircle2,
  ShieldX,
  Copy,
  Check,
} from 'lucide-react'
import { useModalFocus } from '@/hooks/use-modal-focus'
import {
  getPaymentProofForPreviewModal,
  approvePaymentProofDirectly,
  rejectPaymentProofDirectly,
} from '@/app/actions/payment-proof-admin'

export interface ModalVisualizadorComprovanteProps {
  isOpen: boolean
  onClose: () => void
  urlArquivo: string | null
  nomeArquivo?: string
  tamanhoBytes?: number
  clienteNome?: string
  dataCriacao?: string
  proofId?: string | null
  pedidoId?: string | null
  onAprovarSuccess?: () => void
  onRejeitarSuccess?: () => void
}

export const RECEIPT_PREVIEW_ERROR_MESSAGE =
  'Não foi possível carregar a visualização do comprovante. Tente novamente ou abra o comprovante na conversa.'

let cachedPdfJsPromise: Promise<any> | null = null

async function getPdfJs(): Promise<any> {
  if (typeof window === 'undefined') return null
  if ((window as any).pdfjsLib) {
    const lib = (window as any).pdfjsLib
    lib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.js'
    return lib
  }
  if (cachedPdfJsPromise) return cachedPdfJsPromise

  cachedPdfJsPromise = new Promise((resolve, reject) => {
    if ((window as any).pdfjsLib) {
      resolve((window as any).pdfjsLib)
      return
    }

    const script = document.createElement('script')
    script.src = '/pdfjs/pdf.min.js'
    script.onload = () => {
      const lib = (window as any).pdfjsLib
      if (lib) {
        lib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.js'
        resolve(lib)
      } else {
        reject(new Error('PDF.js indisponível após carregar o script'))
      }
    }
    script.onerror = () => {
      cachedPdfJsPromise = null
      reject(new Error('Falha ao carregar script PDF.js do CDN'))
    }
    document.head.appendChild(script)
  })

  return cachedPdfJsPromise
}

async function rasterizePdfPageToPng(doc: any, pageNum: number, scale = 2.0): Promise<string> {
  const page = await doc.getPage(pageNum)
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = viewport.width
  canvas.height = viewport.height
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Não foi possível inicializar o canvas 2D para conversão')
  }

  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)

  const renderContext = {
    canvasContext: context,
    viewport: viewport,
  }
  await page.render(renderContext).promise
  return canvas.toDataURL('image/png')
}

type ProofModalDetails = {
  proof: {
    id: string
    status: string
    channel: string
    suggested_cents: number | null
    confirmed_cents: number | null
    extraction_confidence: number | null
    is_reconciled: boolean | null
    preview_url: string
    original_url: string
  }
  order: {
    id: string
    total_pedido_centavos: number
    status: string
    status_pagamento: string
    data_criacao: string
  } | null
}

export default function ModalVisualizadorComprovante({
  isOpen,
  onClose,
  urlArquivo,
  nomeArquivo = 'comprovante.pdf',
  tamanhoBytes,
  clienteNome,
  dataCriacao,
  proofId,
  pedidoId,
  onAprovarSuccess,
  onRejeitarSuccess,
}: ModalVisualizadorComprovanteProps) {
  const [carregando, setCarregando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [zoom, setZoom] = useState(100)
  const [baixando, setBaixando] = useState(false)
  const [pngDataUrl, setPngDataUrl] = useState<string | null>(null)
  const [originalBlob, setOriginalBlob] = useState<Blob | null>(null)

  // Detalhes do comprovante e pedido vinculado
  const [proofDetails, setProofDetails] = useState<ProofModalDetails | null>(null)
  const [detalhesCarregando, setDetalhesCarregando] = useState(false)
  const [acaoCarregando, setAcaoCarregando] = useState(false)
  const [acaoFeedback, setAcaoFeedback] = useState<{ tipo: 'sucesso' | 'erro'; msg: string } | null>(null)
  const [copiado, setCopiado] = useState(false)
  const dialogRef = useModalFocus(isOpen, onClose)

  // PDF pagination state
  const [numPages, setNumPages] = useState<number>(1)
  const [currentPage, setCurrentPage] = useState<number>(1)
  const [pdfDoc, setPdfDoc] = useState<any>(null)
  const pdfDocRef = useRef<any>(null)

  const effectiveProofId = proofId || (urlArquivo?.match(/\/api\/payment-proofs\/([0-9a-f-]+)/i)?.[1] ?? null)

  const isPdf =
    nomeArquivo.toLowerCase().endsWith('.pdf') ||
    (urlArquivo?.toLowerCase().includes('.pdf') ?? false)

  // Carregar detalhes do comprovante e do pedido correspondente
  useEffect(() => {
    let active = true

    if (!isOpen || !effectiveProofId) {
      setProofDetails(null)
      setAcaoFeedback(null)
      return () => { active = false }
    }

    setDetalhesCarregando(true)
    setAcaoFeedback(null)
    setProofDetails(null)

    getPaymentProofForPreviewModal(effectiveProofId)
      .then((res) => {
        if (active && res.success && res.data && res.data.proof.id === effectiveProofId) {
          setProofDetails(res.data)
        }
      })
      .catch((err) => {
        if (active) console.warn('Não foi possível carregar detalhes do comprovante:', err)
      })
      .finally(() => {
        if (active) setDetalhesCarregando(false)
      })

    return () => { active = false }
  }, [isOpen, effectiveProofId])

  const carregarPaginaComoPng = useCallback(
    async (doc: any, pageNum: number) => {
      if (!doc) return
      setCarregando(true)
      try {
        const pngUrl = await rasterizePdfPageToPng(doc, pageNum, 2.0)
        setPngDataUrl(pngUrl)
      } catch (err: any) {
        console.error('Erro ao converter página PDF em PNG:', err)
        setErro(RECEIPT_PREVIEW_ERROR_MESSAGE)
      } finally {
        setCarregando(false)
      }
    },
    []
  )

  useEffect(() => {
    if (pdfDoc && isPdf && currentPage > 1) {
      carregarPaginaComoPng(pdfDoc, currentPage)
    }
  }, [pdfDoc, currentPage, isPdf, carregarPaginaComoPng])

  useEffect(() => {
    let createdBlobUrl: string | null = null
    let ativo = true

    if (!isOpen || !urlArquivo) {
      setPngDataUrl(null)
      setOriginalBlob(null)
      void pdfDocRef.current?.destroy?.()
      pdfDocRef.current = null
      setPdfDoc(null)
      setErro(null)
      setZoom(100)
      setCurrentPage(1)
      setNumPages(1)
      return
    }

    const processarArquivo = async () => {
      setCarregando(true)
      setErro(null)

      try {
        if (urlArquivo.includes('/api/receipts/')) {
          const imageEndpoint = urlArquivo.replace('/pdf', '/svg')
          const pdfEndpoint = urlArquivo

          const [imgRes, pdfRes] = await Promise.all([
            fetch(imageEndpoint),
            fetch(pdfEndpoint),
          ])

          if (imgRes.ok) {
            const imgBlob = await imgRes.blob()
            createdBlobUrl = URL.createObjectURL(imgBlob)
            if (ativo) {
              setPngDataUrl(createdBlobUrl)
            }
          }

          if (pdfRes.ok) {
            const pdfBlob = await pdfRes.blob()
            if (ativo) {
              setOriginalBlob(pdfBlob)
            }
          }

          if (!imgRes.ok && !pdfRes.ok) {
            throw new Error('Falha ao carregar o comprovante do servidor.')
          }

          return
        }

        // Caso seja a rota de preview do payment-proof
        if (urlArquivo.includes('/api/payment-proofs/')) {
          const res = await fetch(urlArquivo)
          if (!res.ok) {
            throw new Error(`Falha ao carregar prévia (${res.status})`)
          }
          const blob = await res.blob()
          if (!ativo) return
          createdBlobUrl = URL.createObjectURL(blob)
          setPngDataUrl(createdBlobUrl)
          return
        }

        let endpoint = urlArquivo
        if (
          !urlArquivo.startsWith('http://') &&
          !urlArquivo.startsWith('https://') &&
          !urlArquivo.startsWith('/api/') &&
          !urlArquivo.startsWith('blob:') &&
          !urlArquivo.startsWith('data:')
        ) {
          endpoint = `/api/chat/midia?path=${encodeURIComponent(urlArquivo)}`
        }

        if (isPdf) {
          try {
            const previewEndpoint = endpoint.includes('?') ? `${endpoint}&preview=true` : `${endpoint}?preview=true`
            const previewRes = await fetch(previewEndpoint)
            if (previewRes.ok && previewRes.headers?.get?.('content-type')?.includes('image')) {
              const previewBlob = await previewRes.blob()
              if (!ativo) return
              createdBlobUrl = URL.createObjectURL(previewBlob)
              setPngDataUrl(createdBlobUrl)
              setNumPages(1)
              setCurrentPage(1)
              return
            }
          } catch (serverPreviewErr) {
            console.warn('Prévia do servidor indisponível, tentando download do original:', serverPreviewErr)
          }
        }

        const res = await fetch(endpoint)
        if (!res.ok) {
          throw new Error(`Falha na resposta do servidor (${res.status})`)
        }

        const arrayBuffer = await res.arrayBuffer()
        if (!ativo) return

        const mimeType = isPdf ? 'application/pdf' : (res.headers?.get ? res.headers.get('content-type') : null) || 'image/png'
        const blob = new Blob([arrayBuffer], { type: mimeType })
        setOriginalBlob(blob)

        if (isPdf) {
          try {
            const lib = await getPdfJs()
            if (!lib) throw new Error('Biblioteca PDF.js não carregada')

            const loadingTask = lib.getDocument({ data: arrayBuffer, useSystemFonts: true })
            const doc = await loadingTask.promise
            if (!ativo) return

            pdfDocRef.current = doc
            setPdfDoc(doc)
            setNumPages(doc.numPages)
            setCurrentPage(1)

            await carregarPaginaComoPng(doc, 1)
          } catch (pdfErr: any) {
            console.warn('Não foi possível rasterizar via PDF.js, utilizando leitor nativo:', pdfErr)
            createdBlobUrl = URL.createObjectURL(blob)
            if (ativo) setPngDataUrl(createdBlobUrl)
          }
        } else {
          createdBlobUrl = URL.createObjectURL(blob)
          if (ativo) setPngDataUrl(createdBlobUrl)
        }
      } catch (err: any) {
        console.error('Erro ao processar arquivo no visualizador:', err)
        if (ativo) {
          setErro(RECEIPT_PREVIEW_ERROR_MESSAGE)
        }
      } finally {
        if (ativo) {
          setCarregando(false)
        }
      }
    }

    processarArquivo()

    return () => {
      ativo = false
      if (createdBlobUrl) URL.revokeObjectURL(createdBlobUrl)
      void pdfDocRef.current?.destroy?.()
      pdfDocRef.current = null
    }
  }, [isOpen, urlArquivo, isPdf, carregarPaginaComoPng])

  const handleDownload = () => {
    const targetUrl = pngDataUrl || (originalBlob ? URL.createObjectURL(originalBlob) : null)
    if (!targetUrl) {
      setErro('A prévia está indisponível para download.')
      return
    }
    setBaixando(true)
    try {
      const a = document.createElement('a')
      a.href = targetUrl
      a.download = nomeArquivo ? nomeArquivo.replace(/\.pdf$/i, '.png') : 'comprovante-preview.png'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      if (!pngDataUrl && targetUrl) URL.revokeObjectURL(targetUrl)
    } catch (err) {
      console.warn('Erro ao disparar download:', err)
    } finally {
      setBaixando(false)
    }
  }

  const openSafeImageWindow = (print: boolean) => {
    if (pngDataUrl) {
      const printWindow = window.open('', '_blank')
      if (printWindow) {
        const doc = printWindow.document
        doc.title = `${print ? 'Imprimir comprovante' : 'Prévia do comprovante'} - ${nomeArquivo}`
        doc.body.style.cssText = `margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:${print ? '#fff' : '#09090b'}`
        const image = doc.createElement('img')
        image.src = pngDataUrl
        image.alt = 'Prévia do comprovante'
        image.style.cssText = 'max-width:95vw;max-height:95vh;object-fit:contain'
        if (print) image.addEventListener('load', () => printWindow.print(), { once: true })
        doc.body.appendChild(image)
      }
    }
  }

  const handlePrint = () => openSafeImageWindow(true)

  const handleAbrirNovaAba = () => {
    if (pngDataUrl) {
      openSafeImageWindow(false)
    } else if (originalBlob) {
      const url = URL.createObjectURL(originalBlob)
      const opened = window.open(url, '_blank')
      if (!opened) URL.revokeObjectURL(url)
      else window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    }
  }

  const handleCopiarIdPedido = (id: string) => {
    navigator.clipboard.writeText(id)
    setCopiado(true)
    setTimeout(() => setCopiado(false), 2000)
  }

  // Ações de Aprovação e Rejeição
  const handleAprovar = async () => {
    if (
      !effectiveProofId ||
      proofDetails?.proof?.id !== effectiveProofId ||
      !proofDetails?.order?.id
    ) return
    setAcaoCarregando(true)
    setAcaoFeedback(null)

    try {
      const valorCentavos =
        proofDetails.proof.confirmed_cents ||
        proofDetails.proof.suggested_cents ||
        proofDetails.order.total_pedido_centavos

      const res = await approvePaymentProofDirectly(
        proofDetails.proof.id,
        proofDetails.order.id,
        valorCentavos
      )

      if (res.success) {
        setProofDetails((prev) =>
          prev
            ? {
                ...prev,
                proof: { ...prev.proof, status: 'admitted' },
                order: prev.order ? { ...prev.order, status_pagamento: 'aprovado' } : null,
              }
            : null
        )
        setAcaoFeedback({
          tipo: 'sucesso',
          msg: '✓ Comprovante aprovado e conciliação comprovante–pedido concluída.',
        })
        window.dispatchEvent(
          new CustomEvent('asados:order-updated', {
            detail: {
              orderId: proofDetails.order.id,
              proofId: proofDetails.proof.id,
              statusPagamento: 'aprovado',
            },
          })
        )
        onAprovarSuccess?.()
      } else {
        setAcaoFeedback({
          tipo: 'erro',
          msg: `Erro ao aprovar: ${res.error || 'Operação não permitida'}`,
        })
      }
    } catch (e: any) {
      setAcaoFeedback({
        tipo: 'erro',
        msg: e.message || 'Erro inesperado ao aprovar comprovante',
      })
    } finally {
      setAcaoCarregando(false)
    }
  }

  const handleRejeitar = async () => {
    if (!proofDetails?.proof?.id) return
    setAcaoCarregando(true)
    setAcaoFeedback(null)

    try {
      const res = await rejectPaymentProofDirectly(proofDetails.proof.id)
      if (res.success) {
        setProofDetails((prev) =>
          prev
            ? {
                ...prev,
                proof: { ...prev.proof, status: 'quarantined' },
              }
            : null
        )
        setAcaoFeedback({
          tipo: 'sucesso',
          msg: 'Comprovante rejeitado e enviado para quarentena.',
        })
        window.dispatchEvent(
          new CustomEvent('asados:order-updated', {
            detail: {
              orderId: proofDetails?.order?.id,
              proofId: proofDetails.proof.id,
              statusPagamento: 'rejeitado',
            },
          })
        )
        onRejeitarSuccess?.()
      } else {
        setAcaoFeedback({
          tipo: 'erro',
          msg: `Erro ao rejeitar: ${res.error || 'Operação não permitida'}`,
        })
      }
    } catch (e: any) {
      setAcaoFeedback({
        tipo: 'erro',
        msg: e.message || 'Erro inesperado ao rejeitar comprovante',
      })
    } finally {
      setAcaoCarregando(false)
    }
  }

  if (!isOpen || !urlArquivo) return null

  const targetOrder = proofDetails?.order || (pedidoId ? {
    id: pedidoId,
    total_pedido_centavos: proofDetails?.proof?.suggested_cents || 0,
    status: 'pendente',
    status_pagamento: 'pendente',
    data_criacao: new Date().toISOString(),
  } : null)

  const reconciliation = proofDetails?.proof?.is_reconciled
  const isReconciled = reconciliation === true
  const reconciliationUnverifiable = reconciliation !== true && reconciliation !== false
  const isQuarantined = proofDetails?.proof?.status === 'quarantined'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-in fade-in duration-200">
      <div
        ref={dialogRef}
        className="relative w-full max-w-4xl max-h-[94vh] rounded-3xl border border-amber-500/30 bg-zinc-950 p-6 shadow-2xl shadow-black/90 flex flex-col text-zinc-100 overflow-hidden focus:outline-none"
        role="dialog"
        aria-modal="true"
        aria-labelledby="proof-viewer-title"
        tabIndex={-1}
      >
        {/* Efeitos de fundo sutis */}
        <div className="absolute -top-32 -right-32 h-64 w-64 rounded-full bg-amber-500/10 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-32 -left-32 h-64 w-64 rounded-full bg-orange-500/10 blur-3xl pointer-events-none" />

        {/* Header do Visualizador */}
        <div className="flex items-center justify-between pb-3 border-b border-zinc-800/80 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-400">
              <ImageIcon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
                  <Sparkles className="h-3 w-3 text-emerald-400" />
                  {urlArquivo.includes('/api/receipts/')
                    ? 'Prévia vetorial do comprovante'
                    : isPdf
                    ? 'Prévia gerada do PDF'
                    : 'Imagem do comprovante'}
                </span>
                <h3 id="proof-viewer-title" className="text-sm font-bold text-zinc-50 truncate max-w-md">
                  {nomeArquivo}
                </h3>
              </div>
              <p className="text-xs text-zinc-400 mt-0.5 flex flex-wrap items-center gap-3">
                {clienteNome && (
                  <span>
                    <strong className="text-zinc-300">Cliente:</strong> {clienteNome}
                  </span>
                )}
                {tamanhoBytes !== undefined && tamanhoBytes > 0 && (
                  <span>
                    <strong className="text-zinc-300">Tamanho:</strong>{' '}
                    {(tamanhoBytes / 1024).toFixed(1)} KB
                  </span>
                )}
                {dataCriacao && (
                  <span>
                    <strong className="text-zinc-300">Data:</strong>{' '}
                    {new Date(dataCriacao).toLocaleString('pt-BR')}
                  </span>
                )}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 transition-colors cursor-pointer shrink-0 ml-2"
            aria-label="Fechar visualizador"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Card de Comparação Visual com o Pedido e Ações de Aprovação */}
        {detalhesCarregando && (
          <div role="status" className="mt-2 mb-1 px-4 py-2 rounded-xl bg-zinc-900/60 border border-zinc-800 text-xs text-zinc-400 flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />
            <span>Verificando pedido vinculado...</span>
          </div>
        )}
        {targetOrder && (
          <div className="mt-3 mb-1 rounded-2xl bg-zinc-900/95 border border-amber-500/40 p-4 shadow-xl flex flex-wrap items-center justify-between gap-4 shrink-0">
            <div className="flex flex-wrap items-center gap-4">
              {/* Badge Destacado do Pedido para Comparação Imediata */}
              <button
                type="button"
                onClick={() => handleCopiarIdPedido(targetOrder.id)}
                className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-amber-500/20 border border-amber-500/50 shadow-md cursor-pointer hover:bg-amber-500/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                aria-label="Copiar ID do pedido"
              >
                <span className="text-[10px] font-black uppercase tracking-wider text-amber-400">PEDIDO</span>
                <span className="font-mono text-base font-black tracking-tight text-amber-300 select-all">
                  #{targetOrder.id.substring(0, 8).toUpperCase()}
                </span>
                {copiado ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5 text-amber-400/70" />
                )}
              </button>

              {/* Valores e comparação */}
              <div className="flex items-center gap-4 text-xs">
                <div className="flex flex-col">
                  <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Total do Pedido</span>
                  <span className="font-mono font-black text-amber-300 text-sm">
                    R$ {(targetOrder.total_pedido_centavos / 100).toFixed(2).replace('.', ',')}
                  </span>
                </div>

                {proofDetails?.proof?.suggested_cents != null && (
                  <>
                    <span className="text-zinc-600 font-bold">vs</span>
                    <div className="flex flex-col">
                      <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Comprovante PIX</span>
                      <span className="font-mono font-black text-emerald-400 text-sm">
                        R$ {(proofDetails.proof.suggested_cents / 100).toFixed(2).replace('.', ',')}
                      </span>
                    </div>
                  </>
                )}

                <div className="hidden sm:flex items-center gap-2 px-2.5 py-1 rounded-lg bg-zinc-950/70 border border-zinc-800 text-[11px]">
                  <span className="text-zinc-400">Status:</span>
                  <span className="font-bold text-zinc-200 uppercase tracking-wider text-[10px]">
                    {targetOrder.status}
                  </span>
                  <span className="text-zinc-600">·</span>
                  <span className="text-zinc-400">Pagamento:</span>
                  <span className="font-bold text-amber-400 uppercase tracking-wider text-[10px]">
                    {targetOrder.status_pagamento}
                  </span>
                </div>
              </div>
            </div>

            {/* Ações de Aprovação / Rejeição integradas no topo */}
            <div className="flex items-center gap-2 ml-auto">
              {acaoFeedback ? (
                <div
                  role={acaoFeedback.tipo === 'erro' ? 'alert' : 'status'}
                  className={`text-xs font-bold px-3 py-1.5 rounded-xl border flex items-center gap-1.5 ${
                    acaoFeedback.tipo === 'sucesso'
                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                      : 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                  }`}
                >
                  {acaoFeedback.tipo === 'sucesso' ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : (
                    <AlertTriangle className="h-3.5 w-3.5" />
                  )}
                  <span>{acaoFeedback.msg}</span>
                </div>
              ) : isQuarantined ? (
                <div className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-rose-500/20 border border-rose-500/50 text-rose-300 text-xs font-bold shadow-sm">
                  <ShieldX className="h-4 w-4 text-rose-400" />
                  <span>Em Quarentena</span>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={acaoCarregando}
                    onClick={handleRejeitar}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 transition-all cursor-pointer active:scale-95 disabled:opacity-50"
                    title="Mover comprovante para quarentena"
                  >
                    <ShieldX className="h-3.5 w-3.5 text-rose-400" />
                    <span>Passar para Quarentena</span>
                  </button>
                  {isReconciled ? (
                    <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl bg-emerald-500/20 border border-emerald-500/50 text-emerald-300 text-xs font-bold shadow-sm">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                      <span>Conciliado</span>
                    </div>
                  ) : reconciliationUnverifiable ? (
                    <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs font-bold shadow-sm">
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                      <span>Conciliação não verificável</span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={acaoCarregando}
                      onClick={handleAprovar}
                      className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs font-black uppercase tracking-wider bg-emerald-500 hover:bg-emerald-400 text-zinc-950 shadow-md shadow-emerald-500/20 transition-all cursor-pointer active:scale-95 disabled:opacity-50"
                      title="Aprovar comprovante e conciliar o pedido"
                    >
                      {acaoCarregando ? <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-950" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                      <span>Aprovar Comprovante</span>
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* Área central de visualização */}
        <div className="flex-1 min-h-[360px] max-h-[58vh] my-3 rounded-2xl bg-zinc-900/60 border border-zinc-800/80 flex items-center justify-center relative overflow-hidden">
          {carregando ? (
            <div className="flex flex-col items-center gap-3 text-zinc-400">
              <Loader2 className="h-10 w-10 animate-spin text-amber-500" />
              <p className="text-xs font-medium">Gerando prévia do comprovante...</p>
            </div>
          ) : erro ? (
            <div className="flex flex-col items-center gap-3 text-amber-300 p-6 text-center">
              <AlertTriangle className="h-12 w-12 text-amber-400" />
              <p className="text-sm font-bold text-zinc-100">{nomeArquivo}</p>
              <p className="text-xs text-zinc-400 max-w-sm">{erro}</p>
            </div>
          ) : pngDataUrl ? (
            <div className="w-full h-full overflow-auto flex items-center justify-center p-4">
              <div
                className="transition-transform duration-200 flex items-center justify-center shadow-2xl rounded-2xl overflow-hidden border border-zinc-800 bg-white"
                style={{ transform: `scale(${zoom / 100})` }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- Preview is a transient blob or data URL generated from private proof content. */}
                <img
                  src={pngDataUrl}
                  alt={`Prévia do comprovante - ${nomeArquivo}`}
                  className="max-h-[52vh] max-w-full object-contain select-none"
                  onError={() => setErro(RECEIPT_PREVIEW_ERROR_MESSAGE)}
                />
              </div>

              {/* Controles Flutuantes: Zoom & Paginação */}
              <div className="absolute bottom-4 right-4 flex items-center gap-2 p-1.5 rounded-xl bg-zinc-950/90 border border-zinc-800/80 shadow-xl backdrop-blur-md">
                {isPdf && numPages > 1 && (
                  <div className="flex items-center gap-1 pr-2 border-r border-zinc-800">
                    <button
                      type="button"
                      disabled={currentPage <= 1}
                      onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                      className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-300 disabled:opacity-30 cursor-pointer"
                      aria-label="Página anterior"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <span className="text-[11px] font-mono font-bold text-zinc-300 px-1">
                      {currentPage}/{numPages}
                    </span>
                    <button
                      type="button"
                      disabled={currentPage >= numPages}
                      onClick={() => setCurrentPage((p) => Math.min(numPages, p + 1))}
                      className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-300 disabled:opacity-30 cursor-pointer"
                      aria-label="Próxima página"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => setZoom((prev) => Math.max(50, prev - 25))}
                  className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-300 transition-colors cursor-pointer"
                  aria-label="Diminuir zoom"
                >
                  <ZoomOut className="h-4 w-4" />
                </button>
                <span className="text-[10px] font-mono font-bold px-1.5 text-zinc-400">
                  {zoom}%
                </span>
                <button
                  type="button"
                  onClick={() => setZoom((prev) => Math.min(250, prev + 25))}
                  className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-300 transition-colors cursor-pointer"
                  aria-label="Aumentar zoom"
                >
                  <ZoomIn className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setZoom(100)}
                  className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
                  aria-label="Redefinir zoom"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 text-zinc-400">
              <FileText className="h-12 w-12 text-amber-400" />
              <p className="text-sm font-bold text-zinc-200">{nomeArquivo}</p>
            </div>
          )}
        </div>

        {/* Rodapé com Todas as Opções Mantidas */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-zinc-800/80 shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-zinc-400">
              CRM Sofia Manager • Visualizador de comprovante
            </span>
          </div>

          <div className="flex items-center gap-2">
            {(originalBlob || pngDataUrl) && (
              <>
                <button
                  type="button"
                  onClick={handlePrint}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border border-zinc-800 text-xs font-bold transition-all active:scale-95 cursor-pointer"
                  title="Imprimir comprovante"
                >
                  <Printer className="h-3.5 w-3.5" />
                  <span>Imprimir</span>
                </button>

                <button
                  type="button"
                  onClick={handleAbrirNovaAba}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border border-zinc-800 text-xs font-bold transition-all active:scale-95 cursor-pointer"
                  title="Abrir prévia em nova aba"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  <span>Abrir prévia</span>
                </button>

                {originalBlob && originalBlob.size > 0 ? (
                  <button
                    type="button"
                    onClick={handleDownload}
                    disabled={baixando}
                    className="flex items-center gap-2 px-5 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-zinc-950 text-xs font-black shadow-lg shadow-amber-500/15 transition-all active:scale-95 disabled:opacity-50 cursor-pointer"
                  >
                    {baixando ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>Baixando...</span>
                      </>
                    ) : (
                      <>
                        <Download className="h-3.5 w-3.5" />
                        <span>Baixar {isPdf ? 'PDF Original' : 'Comprovante'}</span>
                      </>
                    )}
                  </button>
                ) : isPdf ? (
                  <span className="text-xs text-amber-300">PDF original indisponível</span>
                ) : null}
              </>
            )}

            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 text-xs font-bold transition-all cursor-pointer"
            >
              Fechar
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

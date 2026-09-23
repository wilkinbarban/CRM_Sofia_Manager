'use client'

import React, { useState, useEffect, useRef } from 'react'
import {
  QrCode,
  CreditCard,
  FileCheck,
  Copy,
  Check,
  Loader2,
  X,
  ExternalLink,
  ShieldCheck,
  AlertCircle,
  Clock,
  Sparkles,
  Send,
  UploadCloud,
  FileText,
  Trash2,
} from 'lucide-react'
import {
  gerarCobrancaPixPedido,
  gerarPreferenciaPagamento,
  preflightComprovantePagamentoCliente,
  enviarComprovantePagamentoCliente,
} from '@/app/actions/pedidos'
import { createClient } from '@/lib/supabase/client'

const MAX_COMPROVANTE_BYTES = 5 * 1024 * 1024
const TIPOS_COMPROVANTE = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
} as const

function validarArquivoComprovante(arquivo: File): string | null {
  const extensao = arquivo.name.toLowerCase().match(/\.[^.]+$/)?.[0]
  const extensaoEsperada = TIPOS_COMPROVANTE[arquivo.type as keyof typeof TIPOS_COMPROVANTE]

  if (!extensaoEsperada || !extensao || (extensao !== extensaoEsperada && !(arquivo.type === 'image/jpeg' && extensao === '.jpeg'))) {
    return 'Selecione um comprovante em PDF, JPG/JPEG ou PNG.'
  }
  if (arquivo.size > MAX_COMPROVANTE_BYTES) {
    return 'O arquivo selecionado excede o limite máximo permitido de 5MB.'
  }
  return null
}

export interface ModalPagamentoClienteProps {
  isOpen: boolean
  onClose: () => void
  pedidoId: string
  valorCentavos: number
  statusPagamento: 'pendente' | 'aprovado' | 'rejeitado' | 'reembolsado'
  abaInicial?: 'pix' | 'cartao' | 'comprovante'
  onPagamentoConfirmado?: () => void
  onComprovanteEnviado?: () => void
}

export default function ModalPagamentoCliente({
  isOpen,
  onClose,
  pedidoId,
  valorCentavos,
  statusPagamento: statusInicial,
  abaInicial = 'pix',
  onPagamentoConfirmado,
  onComprovanteEnviado,
}: ModalPagamentoClienteProps) {
  const [abaAtiva, setAbaAtiva] = useState<'pix' | 'cartao' | 'comprovante'>(abaInicial)
  const [statusPagamento, setStatusPagamento] = useState(statusInicial)

  useEffect(() => {
    if (abaInicial) {
      setAbaAtiva(abaInicial)
    }
  }, [abaInicial, isOpen])

  // Estados do PIX
  const [carregandoPix, setCarregandoPix] = useState(false)
  const [dadosPix, setDadosPix] = useState<{
    qrCodeBase64?: string
    qrCodeCopiaCola: string
    ticketUrl?: string
  } | null>(null)
  const [erroPix, setErroPix] = useState<string | null>(null)
  const [copiado, setCopiado] = useState(false)

  // Estados do Cartão / Mercado Pago
  const [carregandoMp, setCarregandoMp] = useState(false)
  const [mpUrl, setMpUrl] = useState<string | null>(null)
  const [erroMp, setErroMp] = useState<string | null>(null)

  // Estados do Comprovante (Upload de PDF/Imagem)
  const [arquivoComprovante, setArquivoComprovante] = useState<File | null>(null)
  const [arrastandoArquivo, setArrastandoArquivo] = useState(false)
  const [textoComprovante, setTextoComprovante] = useState('')
  const [enviandoComprovante, setEnviandoComprovante] = useState(false)
  const [comprovanteEnviado, setComprovanteEnviado] = useState(false)
  const [erroComprovante, setErroComprovante] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const supabase = createClient()

  // Atualiza status local quando props mudam
  useEffect(() => {
    setStatusPagamento(statusInicial)
  }, [statusInicial])

  // Monitora alterações em tempo real no pedido (Webhook de pagamento)
  useEffect(() => {
    if (!isOpen || !pedidoId) return

    const channel = supabase
      .channel(`pagamento-modal-${pedidoId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'pedidos',
          filter: `id=eq.${pedidoId}`,
        },
        (payload) => {
          const novoStatus = (payload.new as any)?.status_pagamento
          if (novoStatus) {
            setStatusPagamento(novoStatus)
            if (novoStatus === 'aprovado' && onPagamentoConfirmado) {
              onPagamentoConfirmado()
            }
          }
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [isOpen, pedidoId, supabase, onPagamentoConfirmado])

  // Carrega cobrança PIX ao abrir modal na aba PIX
  useEffect(() => {
    if (!isOpen || abaAtiva !== 'pix' || dadosPix || statusPagamento === 'aprovado') return

    let ativo = true
    const carregarPix = async () => {
      setCarregandoPix(true)
      setErroPix(null)
      try {
        const res = await gerarCobrancaPixPedido(pedidoId)
        if (!ativo) return
        if (res.success && res.pix) {
          setDadosPix({
            qrCodeBase64: res.pix.qrCodeBase64,
            qrCodeCopiaCola: res.pix.qrCodeCopiaCola,
            ticketUrl: res.pix.ticketUrl,
          })
        } else {
          setErroPix(res.error || 'Não foi possível gerar a chave PIX.')
        }
      } catch {
        if (!ativo) return
        setErroPix('Erro ao conectar ao serviço de pagamentos.')
      } finally {
        if (ativo) setCarregandoPix(false)
      }
    }

    carregarPix()
    return () => {
      ativo = false
    }
  }, [isOpen, abaAtiva, pedidoId, dadosPix, statusPagamento])

  // Carrega link do Mercado Pago ao mudar para aba Cartão
  useEffect(() => {
    if (!isOpen || abaAtiva !== 'cartao' || mpUrl || statusPagamento === 'aprovado') return

    let ativo = true
    const carregarMp = async () => {
      setCarregandoMp(true)
      setErroMp(null)
      try {
        const res = await gerarPreferenciaPagamento(pedidoId)
        if (!ativo) return
        if (res.success && res.url) {
          setMpUrl(res.url)
        } else {
          setErroMp(res.error || 'Não foi possível gerar o link de pagamento.')
        }
      } catch {
        if (!ativo) return
        setErroMp('Erro ao gerar checkout com cartão.')
      } finally {
        if (ativo) setCarregandoMp(false)
      }
    }

    carregarMp()
    return () => {
      ativo = false
    }
  }, [isOpen, abaAtiva, pedidoId, mpUrl, statusPagamento])

  if (!isOpen) return null

  const valorFormatado = (valorCentavos / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })

  const handleCopiarPix = async () => {
    if (!dadosPix?.qrCodeCopiaCola) return
    try {
      await navigator.clipboard.writeText(dadosPix.qrCodeCopiaCola)
      setCopiado(true)
      setTimeout(() => setCopiado(false), 2500)
    } catch (err) {
      console.error('Falha ao copiar:', err)
    }
  }

  const handleEnviarComprovante = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!arquivoComprovante) {
      setErroComprovante('Selecione um comprovante em PDF, JPG/JPEG ou PNG de até 5MB.')
      return
    }

    const erroArquivo = validarArquivoComprovante(arquivoComprovante)
    if (erroArquivo) {
      setErroComprovante(erroArquivo)
      return
    }

    setEnviandoComprovante(true)
    setErroComprovante(null)
    try {
      let urlComprovante: string | undefined = undefined
      let nomeArquivo: string | undefined = undefined
      let tamanhoBytes: number | undefined = undefined

      if (arquivoComprovante) {
        const preflight = await preflightComprovantePagamentoCliente(pedidoId)
        if (!preflight.success) {
          setErroComprovante('Este comprovante não pode mais ser enviado para o pedido selecionado.')
          return
        }

        const cleanName = arquivoComprovante.name.replace(/[^a-zA-Z0-9._-]/g, '_')
        const filePath = `comprovantes/${pedidoId}/${Date.now()}_${cleanName}`

        const { error: uploadError } = await supabase.storage
          .from('chat-midias')
          .upload(filePath, arquivoComprovante, {
            cacheControl: '3600',
            upsert: false,
          })

        if (uploadError) {
          console.error('Erro no upload para chat-midias:', uploadError)
          throw new Error(`Falha no upload do arquivo: ${uploadError.message}`)
        }

        urlComprovante = filePath
        nomeArquivo = arquivoComprovante.name
        tamanhoBytes = arquivoComprovante.size
      }

      const res = await enviarComprovantePagamentoCliente(pedidoId, {
        urlComprovante,
        nomeArquivo,
        tamanhoBytes,
        texto: textoComprovante.trim() || undefined,
      })

      if (res.success) {
        setComprovanteEnviado(true)
        onComprovanteEnviado?.()
        setArquivoComprovante(null)
        setTextoComprovante('')
        if (fileInputRef.current) fileInputRef.current.value = ''
        setTimeout(() => setComprovanteEnviado(false), 6000)
      } else {
        setErroComprovante(
          res.error === 'ORDER_PAYMENT_PROOF_ALREADY_PENDING'
            ? 'Este pedido já possui um comprovante aguardando verificação.'
            : res.error || 'Erro ao registrar comprovante.',
        )
      }
    } catch (err: any) {
      setErroComprovante(err.message || 'Erro técnico ao enviar comprovante.')
    } finally {
      setEnviandoComprovante(false)
    }
  }

  const isPago = statusPagamento === 'aprovado'
  const proofUploadAvailable = statusPagamento === 'pendente'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="relative w-full max-w-lg rounded-3xl border border-amber-500/30 bg-zinc-950 p-6 shadow-2xl shadow-black/80 space-y-5 text-zinc-100 overflow-hidden"
        role="dialog"
        aria-modal="true"
      >
        {/* Efeitos visuais de fundo */}
        <div className="absolute -top-24 -right-24 h-48 w-48 rounded-full bg-amber-500/10 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-24 -left-24 h-48 w-48 rounded-full bg-emerald-500/10 blur-3xl pointer-events-none" />

        {/* Header do Modal */}
        <div className="flex items-center justify-between border-b border-zinc-800/80 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-400">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <span className="text-[10px] font-black uppercase tracking-widest text-amber-500">
                Pagamento Seguro • Pedido
              </span>
              <h2 className="text-base font-black text-zinc-50">
                Pedido #{pedidoId.slice(0, 8).toUpperCase()}
              </h2>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 transition-colors cursor-pointer"
            title="Fechar"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Banner de Valor ou Confirmação */}
        {isPago ? (
          <div className="flex items-center gap-3 p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 animate-in zoom-in-95">
            <ShieldCheck className="h-7 w-7 text-emerald-400 shrink-0" />
            <div>
              <div className="text-sm font-black">Pagamento Confirmado!</div>
              <div className="text-xs text-emerald-400/80">
                Seu pagamento foi recebido e seu pedido já está liberado na cozinha.
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between px-4 py-3 rounded-2xl bg-zinc-900/80 border border-zinc-800">
            <span className="text-xs text-zinc-400">Total a pagar:</span>
            <span className="font-mono text-xl font-black text-amber-400">{valorFormatado}</span>
          </div>
        )}

        {/* Abas de Navegação */}
        {!isPago && (
          <div className="flex rounded-2xl bg-zinc-900/60 p-1 border border-zinc-800/80">
            <button
              type="button"
              onClick={() => setAbaAtiva('pix')}
              className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                abaAtiva === 'pix'
                  ? 'bg-amber-500 text-zinc-950 shadow-md shadow-amber-500/10'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <QrCode className="h-3.5 w-3.5" />
              <span>PIX Instantâneo</span>
            </button>

            <button
              type="button"
              onClick={() => setAbaAtiva('cartao')}
              className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                abaAtiva === 'cartao'
                  ? 'bg-amber-500 text-zinc-950 shadow-md shadow-amber-500/10'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <CreditCard className="h-3.5 w-3.5" />
              <span>Cartão / MP</span>
            </button>

            {proofUploadAvailable && (
              <button
                type="button"
                onClick={() => setAbaAtiva('comprovante')}
                className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                  abaAtiva === 'comprovante'
                    ? 'bg-amber-500 text-zinc-950 shadow-md shadow-amber-500/10'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <FileCheck className="h-3.5 w-3.5" />
                <span>Comprovante</span>
              </button>
            )}
          </div>
        )}

        {/* Conteúdo da Aba PIX */}
        {abaAtiva === 'pix' && !isPago && (
          <div className="space-y-4">
            {carregandoPix ? (
              <div className="py-12 flex flex-col items-center justify-center gap-2 text-zinc-400">
                <Loader2 className="h-8 w-8 animate-spin text-amber-500" />
                <span className="text-xs">Gerando QR Code PIX seguro...</span>
              </div>
            ) : erroPix ? (
              <div className="p-4 rounded-2xl bg-red-500/10 border border-red-500/30 text-red-300 text-xs flex items-center gap-2">
                <AlertCircle className="h-5 w-5 shrink-0 text-red-400" />
                <span>{erroPix}</span>
              </div>
            ) : dadosPix ? (
              <div className="space-y-4 animate-in fade-in">
                {/* QR Code Container */}
                <div className="flex flex-col items-center justify-center p-4 rounded-2xl bg-white border border-zinc-200 shadow-inner">
                  {dadosPix.qrCodeBase64 ? (
                    <div className="relative h-44 w-44 bg-white p-1">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`data:image/png;base64,${dadosPix.qrCodeBase64}`}
                        alt="QR Code PIX Mercado Pago"
                        className="h-full w-full object-contain"
                      />
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center h-44 w-44 text-zinc-500 gap-2">
                      <QrCode className="h-16 w-16 text-zinc-800" />
                      <span className="text-[11px] text-zinc-600 font-medium">QR Code Ativo</span>
                    </div>
                  )}
                  <div className="flex items-center gap-1.5 text-[11px] font-bold text-zinc-700 mt-1">
                    <Clock className="h-3 w-3 text-amber-600" />
                    <span>PIX processado via Mercado Pago — a confirmação depende do seu banco</span>
                  </div>
                </div>

                {/* Copia e Cola */}
                <div className="space-y-1.5">
                  <span className="text-xs font-bold text-zinc-300 block">PIX Copia e Cola</span>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={dadosPix.qrCodeCopiaCola}
                      className="flex-1 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-mono text-zinc-300 select-all truncate focus:outline-none focus:ring-1 focus:ring-amber-500"
                    />
                    <button
                      type="button"
                      onClick={handleCopiarPix}
                      className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-black transition-all shrink-0 cursor-pointer ${
                        copiado
                          ? 'bg-emerald-500 text-zinc-950 shadow-md shadow-emerald-500/20'
                          : 'bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-zinc-950'
                      }`}
                    >
                      {copiado ? (
                        <>
                          <Check className="h-3.5 w-3.5" />
                          <span>Copiado!</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" />
                          <span>Copiar</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        )}

        {/* Conteúdo da Aba Cartão / Mercado Pago */}
        {abaAtiva === 'cartao' && !isPago && (
          <div className="space-y-4 py-2 animate-in fade-in">
            {carregandoMp ? (
              <div className="py-12 flex flex-col items-center justify-center gap-2 text-zinc-400">
                <Loader2 className="h-8 w-8 animate-spin text-amber-500" />
                <span className="text-xs">Preparando checkout seguro do Mercado Pago...</span>
              </div>
            ) : erroMp ? (
              <div className="p-4 rounded-2xl bg-red-500/10 border border-red-500/30 text-red-300 text-xs flex items-center gap-2">
                <AlertCircle className="h-5 w-5 shrink-0 text-red-400" />
                <span>{erroMp}</span>
              </div>
            ) : mpUrl ? (
              <div className="space-y-4 text-center">
                <div className="p-6 rounded-2xl border border-zinc-800 bg-zinc-900/50 space-y-3">
                  <CreditCard className="h-10 w-10 text-amber-400 mx-auto" />
                  <h3 className="text-sm font-black text-zinc-100">
                    Pague com Cartão de Crédito, Débito ou Saldo Mercado Pago
                  </h3>
                  <p className="text-xs text-zinc-400 max-w-sm mx-auto">
                    Você será direcionado ao ambiente 100% criptografado e seguro do Mercado Pago para concluir sua transação.
                  </p>
                </div>

                <a
                  href={mpUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-zinc-950 text-xs font-black shadow-lg shadow-amber-500/20 transition-all active:scale-95 cursor-pointer"
                >
                  <ExternalLink className="h-4 w-4" />
                  <span>Abrir Checkout Seguro Mercado Pago</span>
                </a>
              </div>
            ) : null}
          </div>
        )}

        {/* Conteúdo da Aba Enviar Comprovante (PDF/Imagem) */}
        {abaAtiva === 'comprovante' && proofUploadAvailable && !isPago && (
          <form onSubmit={handleEnviarComprovante} className="space-y-3.5 py-1 animate-in fade-in">
            {/* Input de arquivo oculto */}
            <input
              type="file"
              ref={fileInputRef}
              accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (!file) return
                const erroArquivo = validarArquivoComprovante(file)
                if (erroArquivo) {
                  setArquivoComprovante(null)
                  setErroComprovante(erroArquivo)
                  e.target.value = ''
                  return
                }
                setArquivoComprovante(file)
                setErroComprovante(null)
              }}
              className="hidden"
            />

            {/* Zona de Seleção / Dropzone de PDF ou Imagem */}
            {arquivoComprovante ? (
              <div className="flex items-center justify-between p-3.5 rounded-2xl border border-amber-500/40 bg-zinc-900/90 shadow-md">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400">
                    <FileText className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-wider bg-amber-500/20 text-amber-300 border border-amber-500/30">
                        {arquivoComprovante.type === 'application/pdf' ? 'PDF' : arquivoComprovante.type === 'image/png' ? 'PNG' : 'JPG'}
                      </span>
                      <p className="text-xs font-bold text-zinc-100 truncate max-w-[220px]">
                        {arquivoComprovante.name}
                      </p>
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-0.5">
                      {(arquivoComprovante.size / 1024).toFixed(1)} KB • Pronto para envio
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setArquivoComprovante(null)
                    if (fileInputRef.current) fileInputRef.current.value = ''
                  }}
                  className="rounded-xl p-2 text-zinc-400 hover:bg-zinc-800 hover:text-red-400 transition-colors cursor-pointer"
                  title="Remover arquivo"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault()
                  setArrastandoArquivo(true)
                }}
                onDragLeave={() => setArrastandoArquivo(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setArrastandoArquivo(false)
                  const file = e.dataTransfer.files?.[0]
                  if (!file) return
                  const erroArquivo = validarArquivoComprovante(file)
                  if (erroArquivo) {
                    setArquivoComprovante(null)
                    setErroComprovante(erroArquivo)
                    return
                  }
                  setArquivoComprovante(file)
                  setErroComprovante(null)
                }}
                className={`flex flex-col items-center justify-center p-5 rounded-2xl border-2 border-dashed transition-all cursor-pointer text-center ${
                  arrastandoArquivo
                    ? 'border-amber-500 bg-amber-500/10 scale-[1.01]'
                    : 'border-zinc-800 bg-zinc-900/40 hover:border-amber-500/50 hover:bg-zinc-900/70'
                }`}
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-400 mb-2">
                  <UploadCloud className="h-5 w-5" />
                </div>
                <p className="text-xs font-bold text-zinc-200">
                  Clique para selecionar ou arraste o comprovante
                </p>
                <p className="text-[10px] text-zinc-400 mt-1">
                  PDF, JPG/JPEG ou PNG de até 5MB • o pagamento será analisado antes da confirmação
                </p>
              </div>
            )}

            {/* Observações adicionais */}
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-zinc-300 block">
                Observação adicional (opcional)
              </label>
              <textarea
                rows={2}
                value={textoComprovante}
                onChange={(e) => setTextoComprovante(e.target.value)}
                placeholder="Ex: Realizei o pagamento às 12:10 via PIX/Cartão Mercado Pago..."
                className="w-full rounded-2xl border border-zinc-800 bg-zinc-900/90 p-3 text-xs text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-amber-500 resize-none"
              />
            </div>

            {comprovanteEnviado && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-medium animate-in fade-in">
                <Check className="h-4 w-4 shrink-0 text-emerald-400" />
                <span>Comprovante enviado com sucesso! O atendente foi notificado no painel para validar seu pedido.</span>
              </div>
            )}

            {erroComprovante && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-xs font-medium animate-in fade-in">
                <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
                <span>{erroComprovante}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={enviandoComprovante || !arquivoComprovante}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-zinc-950 text-xs font-black shadow-md shadow-amber-500/10 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {enviandoComprovante ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Enviando Comprovante...</span>
                </>
              ) : (
                <>
                  <Send className="h-4 w-4" />
                  <span>Enviar Comprovante ao Atendimento</span>
                </>
              )}
            </button>
          </form>
        )}

        {/* Botão de Fechar / Concluir */}
        <div className="pt-2 border-t border-zinc-800/80 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 text-xs font-bold transition-all cursor-pointer"
          >
            {isPago ? 'Fechar' : 'Concluir Depois'}
          </button>
        </div>
      </div>
    </div>
  )
}

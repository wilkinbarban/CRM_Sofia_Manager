'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Check, CheckCircle2, Inbox, Loader2, PencilLine, RefreshCw, Sparkles, X } from 'lucide-react'
import {
  listarFatosCliente,
  revisarFatoCliente,
  type DecisaoRevisaoFato,
  type FatoClienteListado,
} from '@/app/actions/fatos-cliente'

interface OperatorClientFactsPanelProps {
  clienteId: string
  clienteNome?: string
}

/**
 * O painel nao acessa a tabela de fatos diretamente: toda leitura e escrita passa pelas actions de
 * `@/app/actions/fatos-cliente`, que aplicam o gate de operador no servidor. O token cru da action
 * (sessao ou banco) nunca e renderizado: o operador ve o estado de recusa, nao o vocabulario interno.
 */
const ERRO_AO_CARREGAR = 'Não foi possível carregar os fatos deste cliente. Verifique sua permissão de operador.'
const ERRO_AO_REVISAR = 'Não foi possível revisar este fato. Tente novamente.'

const ROTULO_ESTADO: Record<string, string> = {
  pendente: 'Pendente',
  aprovado: 'Aprovado',
  rejeitado: 'Rejeitado',
  substituido: 'Substituído',
}

const CLASSE_ESTADO: Record<string, string> = {
  pendente: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
  aprovado: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  rejeitado: 'border-red-500/30 bg-red-500/10 text-red-400',
  substituido: 'border-zinc-700 bg-zinc-800/60 text-zinc-400',
}

const ROTULO_ORIGEM: Record<string, string> = {
  cliente: 'Cliente',
  operador: 'Operador',
  ia: 'IA (inferido)',
  importado: 'Importado',
}

const MENSAGEM_REVISAO: Record<DecisaoRevisaoFato, string> = {
  aprovar: 'Fato aprovado.',
  rejeitar: 'Fato rejeitado.',
  corrigir: 'Fato corrigido.',
}

export default function OperatorClientFactsPanel({ clienteId, clienteNome }: OperatorClientFactsPanelProps) {
  const [fatos, setFatos] = useState<FatoClienteListado[]>([])
  const [loading, setLoading] = useState(true)
  const [erroCarregamento, setErroCarregamento] = useState<string | null>(null)
  const [erroAcao, setErroAcao] = useState<string | null>(null)
  const [mensagem, setMensagem] = useState<string | null>(null)
  const [acaoEmAndamento, setAcaoEmAndamento] = useState<string | null>(null)
  const [correcao, setCorrecao] = useState<{ fatoId: string; valor: string } | null>(null)

  const carregarFatos = useCallback(async (silencioso = false) => {
    if (!silencioso) setLoading(true)
    setErroCarregamento(null)

    try {
      const res = await listarFatosCliente(clienteId)
      if (res.success) {
        setFatos(res.data ?? [])
      } else {
        // Um resultado recusado nunca vira linha, mesmo que o payload traga `data`.
        setFatos([])
        setErroCarregamento(ERRO_AO_CARREGAR)
      }
    } catch (err) {
      console.error('Erro ao carregar os fatos do cliente:', err)
      setFatos([])
      setErroCarregamento(ERRO_AO_CARREGAR)
    } finally {
      setLoading(false)
    }
  }, [clienteId])

  useEffect(() => {
    carregarFatos()
  }, [carregarFatos])

  const revisar = async (fatoId: string, decisao: DecisaoRevisaoFato, valor: string | null) => {
    setAcaoEmAndamento(fatoId)
    setErroAcao(null)
    setMensagem(null)

    try {
      const res = await revisarFatoCliente(fatoId, decisao, valor)
      if (!res.success) {
        setErroAcao(ERRO_AO_REVISAR)
        return
      }
      setCorrecao(null)
      setMensagem(MENSAGEM_REVISAO[decisao])
      await carregarFatos(true)
    } catch (err) {
      console.error('Erro ao revisar o fato do cliente:', err)
      setErroAcao(ERRO_AO_REVISAR)
    } finally {
      setAcaoEmAndamento(null)
    }
  }

  if (loading) {
    return (
      <div role="status" data-testid="fatos-carregando" className="flex h-full flex-col items-center justify-center p-6 text-zinc-500">
        <Loader2 className="mb-2 h-6 w-6 animate-spin text-amber-500" />
        <p className="text-xs">Carregando fatos do cliente{clienteNome ? ` de ${clienteNome}` : ''}...</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900/40 px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-500" />
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-200">
            Fatos do cliente ({fatos.length})
          </span>
        </div>
        <button
          type="button"
          onClick={() => carregarFatos(true)}
          aria-label="Atualizar fatos do cliente"
          className="cursor-pointer rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 focus:outline-none"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {erroCarregamento && (
        <div role="alert" data-testid="fatos-erro" className="m-4 flex shrink-0 items-center gap-2 rounded-lg border border-red-900/50 bg-red-950/40 p-2.5 text-xs text-red-200">
          <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
          <span className="flex-1">{erroCarregamento}</span>
        </div>
      )}

      {erroAcao && (
        <div role="alert" data-testid="fatos-erro-acao" className="mx-4 mt-3 flex shrink-0 items-center gap-2 rounded-lg border border-red-900/50 bg-red-950/40 p-2.5 text-xs text-red-200">
          <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
          <span className="flex-1">{erroAcao}</span>
        </div>
      )}

      {mensagem && (
        <div role="status" data-testid="fatos-sucesso" className="mx-4 mt-3 flex shrink-0 items-center gap-2 rounded-lg border border-emerald-900/50 bg-emerald-950/40 p-2.5 text-xs text-emerald-200">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
          <span className="flex-1">{mensagem}</span>
        </div>
      )}

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {erroCarregamento ? null : fatos.length === 0 ? (
          <div data-testid="fatos-vazio" className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 p-8 text-center text-zinc-500">
            <Inbox className="mb-2 h-8 w-8 stroke-zinc-700" />
            <p className="text-xs font-medium text-zinc-400">Nenhum fato registrado para este cliente</p>
            <p className="mt-1 max-w-[220px] text-[11px] text-zinc-600">
              Fatos pendentes, aprovados, rejeitados e substituídos aparecem aqui.
            </p>
          </div>
        ) : (
          <ul data-testid="fatos-lista" className="space-y-3">
            {fatos.map((fato) => {
              const ehObservacao = fato.tipo === 'observacao'
              const confianca = fato.origem === 'ia' && typeof fato.confianca === 'number'
                ? `${Math.round(fato.confianca * 100)}%`
                : null
              const podeRevisar = fato.estado === 'pendente'
              const emAndamento = acaoEmAndamento === fato.fato_id
              const emCorrecao = correcao?.fatoId === fato.fato_id

              return (
                <li
                  key={fato.fato_id}
                  data-testid={`fato-${fato.fato_id}`}
                  data-tipo={fato.tipo}
                  data-estado={fato.estado}
                  data-origem={fato.origem}
                  data-variante={ehObservacao ? 'observacao' : 'cliente'}
                  className={`rounded-xl border p-3 ${
                    ehObservacao
                      ? 'border-dashed border-sky-900/70 bg-sky-950/10'
                      : 'border-zinc-800 bg-zinc-900/30'
                  }`}
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span
                      data-testid="fato-variante"
                      className={`text-[10px] font-bold uppercase tracking-wider ${
                        ehObservacao ? 'text-sky-400' : 'text-zinc-500'
                      }`}
                    >
                      {ehObservacao ? 'Observação — não é um fato do cliente' : 'Fato do cliente'}
                    </span>
                    <span
                      data-testid="fato-estado"
                      className={`rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                        CLASSE_ESTADO[fato.estado] ?? 'border-zinc-700 bg-zinc-800 text-zinc-400'
                      }`}
                    >
                      {ROTULO_ESTADO[fato.estado] ?? fato.estado}
                    </span>
                  </div>

                  <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[11px]">
                    <span className="text-[10px] uppercase text-zinc-500">Tipo</span>
                    <span data-testid="fato-tipo" className="font-mono text-amber-300">{fato.tipo}</span>
                    <span className="text-[10px] uppercase text-zinc-500">Chave</span>
                    <span data-testid="fato-chave" className="font-mono text-zinc-300">{fato.chave}</span>
                    <span className="text-[10px] uppercase text-zinc-500">Valor</span>
                    <span data-testid="fato-valor" className="break-words text-zinc-100">{fato.valor}</span>
                    <span className="text-[10px] uppercase text-zinc-500">Origem</span>
                    <span data-testid="fato-origem" className="text-zinc-300">{ROTULO_ORIGEM[fato.origem] ?? fato.origem}</span>
                    {confianca && (
                      <>
                        <span className="text-[10px] uppercase text-zinc-500">Confiança</span>
                        <span data-testid="fato-confianca" className="font-mono text-amber-400">{confianca}</span>
                      </>
                    )}
                    <span className="text-[10px] uppercase text-zinc-500">Conversa</span>
                    <span data-testid="fato-conversa" className="font-mono text-zinc-400">
                      {fato.origem_conversa_id ?? 'sem conversa de origem'}
                    </span>
                  </div>

                  {!podeRevisar ? (
                    <p data-testid="fato-sem-acoes" className="mt-3 border-t border-zinc-800/60 pt-2 text-[10px] text-zinc-500">
                      Fato já revisado — sem ações disponíveis.
                    </p>
                  ) : emCorrecao ? (
                    <div className="mt-3 space-y-2 border-t border-amber-500/20 pt-2">
                      <label
                        htmlFor={`correcao-${fato.fato_id}`}
                        className="block text-[10px] font-semibold uppercase tracking-wider text-amber-400"
                      >
                        Novo valor para {fato.chave}
                      </label>
                      <textarea
                        id={`correcao-${fato.fato_id}`}
                        rows={2}
                        value={correcao.valor}
                        onChange={(event) => setCorrecao({ fatoId: fato.fato_id, valor: event.target.value })}
                        className="w-full resize-none rounded-lg border border-zinc-800 bg-zinc-900/30 px-3 py-2 text-xs text-zinc-100 focus:border-amber-500/50 focus:outline-none"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={emAndamento}
                          onClick={() => setCorrecao(null)}
                          className="flex cursor-pointer items-center gap-1 rounded-lg border border-zinc-700 px-2 py-1.5 text-[11px] font-bold text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-50"
                        >
                          <X className="h-3 w-3" />
                          Cancelar correção de {fato.chave}
                        </button>
                        <button
                          type="button"
                          disabled={emAndamento || correcao.valor.trim().length === 0}
                          onClick={() => revisar(fato.fato_id, 'corrigir', correcao.valor.trim())}
                          className="flex cursor-pointer items-center gap-1 rounded-lg bg-amber-500 px-2 py-1.5 text-[11px] font-bold text-zinc-950 transition-colors hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {emAndamento ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                          Confirmar correção de {fato.chave}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 flex flex-wrap gap-1.5 border-t border-zinc-800/60 pt-2">
                      <button
                        type="button"
                        disabled={emAndamento}
                        aria-label={`Aprovar fato ${fato.chave}`}
                        onClick={() => revisar(fato.fato_id, 'aprovar', null)}
                        className="flex cursor-pointer items-center gap-1 rounded-lg bg-amber-500 px-2 py-1.5 text-[11px] font-bold text-zinc-950 transition-colors hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {emAndamento ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                        Aprovar
                      </button>
                      <button
                        type="button"
                        disabled={emAndamento}
                        aria-label={`Rejeitar fato ${fato.chave}`}
                        onClick={() => revisar(fato.fato_id, 'rejeitar', null)}
                        className="flex cursor-pointer items-center gap-1 rounded-lg border border-zinc-700 px-2 py-1.5 text-[11px] font-bold text-zinc-300 transition-colors hover:border-red-900 hover:bg-red-950/30 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <X className="h-3 w-3" />
                        Rejeitar
                      </button>
                      <button
                        type="button"
                        disabled={emAndamento}
                        aria-label={`Corrigir fato ${fato.chave}`}
                        onClick={() => setCorrecao({ fatoId: fato.fato_id, valor: fato.valor })}
                        className="flex cursor-pointer items-center gap-1 rounded-lg border border-zinc-700 px-2 py-1.5 text-[11px] font-bold text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <PencilLine className="h-3 w-3" />
                        Corrigir
                      </button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

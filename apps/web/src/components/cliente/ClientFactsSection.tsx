'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Check, Inbox, Loader2, PencilLine, Sparkles, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

/**
 * Fatos do proprietario (LGPD): a secao le `meus_fatos_cliente` e escreve por
 * `corrigir_meu_fato_cliente` / `recusar_meu_fato_cliente` com o cliente de navegador, como o resto
 * de `/cliente/perfil`. Nenhuma tabela e lida direto e nenhum id de cliente entra no payload: o
 * cliente e resolvido por `auth.uid()` dentro do RPC, que so devolve fatos aprovados e nunca
 * `observacao`, com projecao estreita (sem confianca nem cadeia de revisao).
 */
type FatoDoCliente = {
  fato_id: string
  tipo: string
  chave: string
  valor: string
  origem: string
}

// Mesmo default do RPC (`p_limite` vale 200 quando omitido; o maximo aceito tambem e 200).
const LIMITE_FATOS_CLIENTE = 200

const ERRO_AO_CARREGAR = 'Não foi possível carregar suas informações. Tente novamente em instantes.'
const ERRO_AO_ALTERAR = 'Não foi possível concluir a alteração. Tente novamente em instantes.'

// `ia` nunca e rotulado como afirmacao do cliente: a autoria exibida e a origem real do fato.
const AUTORIA: Record<string, string> = {
  cliente: 'Informado por você',
  operador: 'Informado pela equipe',
  importado: 'Importado do seu cadastro',
  ia: 'Sugerido pela Sofia',
}

const ROTULO_TIPO: Record<string, string> = {
  endereco: 'Endereço',
  preferencia: 'Preferência',
  restricao_alimentar: 'Restrição alimentar',
  formato_pedido: 'Formato do pedido',
}

export default function ClientFactsSection() {
  const [supabase] = useState(createClient)
  const [fatos, setFatos] = useState<FatoDoCliente[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erroCarregamento, setErroCarregamento] = useState<string | null>(null)
  const [erroAcao, setErroAcao] = useState<string | null>(null)
  const [emAndamento, setEmAndamento] = useState<string | null>(null)
  const [correcao, setCorrecao] = useState<{ fatoId: string; valor: string } | null>(null)

  const carregarFatos = useCallback(
    async (silencioso = false) => {
      if (!silencioso) setCarregando(true)
      setErroCarregamento(null)

      try {
        const { data, error } = await supabase.rpc('meus_fatos_cliente', { p_limite: LIMITE_FATOS_CLIENTE })

        if (error) {
          // Um resultado recusado nunca vira linha, mesmo que o payload traga `data`, e o token cru
          // do banco (`SOFIA_*`) fica no console: na tela so entra o estado da falha.
          console.error('Erro ao carregar os fatos do cliente:', error.code)
          setFatos([])
          setErroCarregamento(ERRO_AO_CARREGAR)
          return
        }

        // Reforco local: o RPC ja exclui `observacao`; nenhuma linha interna ganha caminho de tela.
        setFatos(((data ?? []) as FatoDoCliente[]).filter((fato) => fato && fato.tipo !== 'observacao'))
      } catch (err) {
        console.error('Erro ao carregar os fatos do cliente:', err)
        setFatos([])
        setErroCarregamento(ERRO_AO_CARREGAR)
      } finally {
        setCarregando(false)
      }
    },
    [supabase]
  )

  useEffect(() => {
    carregarFatos()
  }, [carregarFatos])

  const alterarFato = async (fatoId: string, chamada: () => PromiseLike<{ error: { code?: string | null } | null }>) => {
    setEmAndamento(fatoId)
    setErroAcao(null)

    try {
      const { error } = await chamada()

      if (error) {
        console.error('Erro ao alterar o fato do cliente:', error.code)
        setErroAcao(ERRO_AO_ALTERAR)
        return
      }

      setCorrecao(null)
      // O estado exibido vem do servidor: depois da escrita a lista e lida de novo.
      await carregarFatos(true)
    } catch (err) {
      console.error('Erro ao alterar o fato do cliente:', err)
      setErroAcao(ERRO_AO_ALTERAR)
    } finally {
      setEmAndamento(null)
    }
  }

  return (
    <section
      data-testid="fatos-cliente-secao"
      className="backdrop-blur-md bg-zinc-900/30 border border-zinc-900 rounded-2xl p-6 md:p-8 shadow-xl"
    >
      <div className="mb-4 flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-amber-500">
          <Sparkles className="h-4 w-4" />
        </span>
        <div>
          <h3 className="text-sm font-bold tracking-tight text-white">O que a Sofia sabe sobre você</h3>
          <p className="mt-0.5 text-xs text-zinc-400">
            Informações aprovadas usadas para atendê-lo. Você pode corrigir ou recusar qualquer uma delas.
          </p>
        </div>
      </div>

      {carregando && (
        <div role="status" data-testid="fatos-cliente-carregando" className="flex items-center gap-2 text-xs text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
          <span>Carregando suas informações...</span>
        </div>
      )}

      {erroCarregamento && (
        <div
          role="alert"
          data-testid="fatos-cliente-erro"
          className="flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs font-medium text-red-400"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{erroCarregamento}</span>
        </div>
      )}

      {erroAcao && (
        <div
          role="alert"
          data-testid="fatos-cliente-erro-acao"
          className="mt-3 flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs font-medium text-red-400"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{erroAcao}</span>
        </div>
      )}

      {!carregando && !erroCarregamento && fatos.length === 0 && (
        <div
          data-testid="fatos-cliente-vazio"
          className="flex flex-col items-center rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 p-6 text-center"
        >
          <Inbox className="mb-2 h-6 w-6 stroke-zinc-700" />
          <p className="text-xs font-medium text-zinc-400">Nada registrado por aqui ainda</p>
          <p className="mt-1 text-[11px] text-zinc-600">
            Quando a Sofia aprender algo aprovado sobre você, aparece nesta lista.
          </p>
        </div>
      )}

      {!erroCarregamento && fatos.length > 0 && (
        <ul data-testid="fatos-cliente-lista" className="space-y-3">
          {fatos.map((fato) => {
            const emCorrecao = correcao?.fatoId === fato.fato_id
            const ocupado = emAndamento === fato.fato_id
            const proprio = fato.origem === 'cliente'

            return (
              <li
                key={fato.fato_id}
                data-testid="fato-cliente-item"
                data-fato-id={fato.fato_id}
                data-tipo={fato.tipo}
                data-origem={fato.origem}
                className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                      {ROTULO_TIPO[fato.tipo] ?? fato.tipo}
                    </p>
                    <p data-testid="fato-cliente-valor" className="break-words text-sm font-medium text-zinc-100">
                      {fato.valor}
                    </p>
                  </div>
                  <span
                    data-testid="fato-cliente-autoria"
                    className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                      proprio
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                        : 'border-zinc-800 bg-zinc-900 text-zinc-400'
                    }`}
                  >
                    {AUTORIA[fato.origem] ?? 'Registrado'}
                  </span>
                </div>

                {emCorrecao ? (
                  <div className="mt-3 space-y-2 border-t border-amber-500/20 pt-3">
                    <label
                      htmlFor={`correcao-fato-cliente-${fato.fato_id}`}
                      className="block text-[10px] font-semibold uppercase tracking-wider text-amber-400"
                    >
                      Novo valor para {fato.chave}
                    </label>
                    <textarea
                      id={`correcao-fato-cliente-${fato.fato_id}`}
                      rows={2}
                      value={correcao.valor}
                      onChange={(event) => setCorrecao({ fatoId: fato.fato_id, valor: event.target.value })}
                      className="w-full resize-none rounded-xl border border-zinc-800 bg-zinc-950/80 px-3 py-2 text-sm text-white focus:border-amber-500 focus:outline-hidden focus:ring-2 focus:ring-amber-500/20"
                    />
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={ocupado}
                        aria-label={`Cancelar correção de ${fato.chave}`}
                        onClick={() => setCorrecao(null)}
                        className="flex items-center gap-1 rounded-xl border border-zinc-800 px-3 py-1.5 text-[11px] font-bold text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-50"
                      >
                        <X className="h-3 w-3" />
                        Cancelar
                      </button>
                      <button
                        type="button"
                        disabled={ocupado || correcao.valor.trim().length === 0}
                        aria-label={`Confirmar correção de ${fato.chave}`}
                        onClick={() =>
                          alterarFato(fato.fato_id, () =>
                            supabase.rpc('corrigir_meu_fato_cliente', {
                              p_fato_id: fato.fato_id,
                              p_valor: correcao.valor.trim(),
                            })
                          )
                        }
                        className="flex items-center gap-1 rounded-xl bg-linear-to-r from-red-600 to-amber-500 px-3 py-1.5 text-[11px] font-bold text-white transition-all hover:from-red-500 hover:to-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {ocupado ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                        Salvar correção
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2 border-t border-zinc-800/60 pt-3">
                    <button
                      type="button"
                      disabled={ocupado}
                      aria-label={`Corrigir fato ${fato.chave}`}
                      onClick={() => setCorrecao({ fatoId: fato.fato_id, valor: fato.valor })}
                      className="flex items-center gap-1 rounded-xl border border-zinc-800 px-3 py-1.5 text-[11px] font-bold text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <PencilLine className="h-3 w-3" />
                      Corrigir
                    </button>
                    <button
                      type="button"
                      disabled={ocupado}
                      aria-label={`Recusar fato ${fato.chave}`}
                      onClick={() =>
                        alterarFato(fato.fato_id, () => supabase.rpc('recusar_meu_fato_cliente', { p_fato_id: fato.fato_id }))
                      }
                      className="flex items-center gap-1 rounded-xl border border-zinc-800 px-3 py-1.5 text-[11px] font-bold text-zinc-300 transition-colors hover:border-red-900 hover:bg-red-950/30 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {ocupado ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                      Não é meu
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

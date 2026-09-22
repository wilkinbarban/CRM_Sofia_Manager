'use client'

import React, { useState } from 'react'
import {
  Users,
  Building2,
  Activity,
  BarChart3,
  Calendar,
  Bot,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Check,
  Search,
  Eye,
  BookOpen,
  RefreshCw,
  ShieldCheck,
  X,
  Trash2,
  User,
  UserPlus,
  Edit3,
  Lock,
  Mail,
  Phone,
  Clock,
  Package,
  FileText,
  Download,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import ModalVisualizadorComprovante from '@/components/comprovantes/ModalVisualizadorComprovante'
import {
  atualizarPerfilUsuario,
  criarUsuarioAdmin,
  editarUsuarioAdmin,
  obterEstatisticasMensagens,
  obterMetricasFinanceirasOperacionais,
  obterLogsAuditoria,
  deletarUsuarioAdmin,
  purgarUsuarioAdminTotal,
  purgarResidualClienteAdmin,
  listarRegistrosAnonimizadosPreservados,
  type AnonymizedResidualClient,
  salvarConfiguracaoAdmin,
  obterComprovantes
} from '@/app/actions/admin'
import {
  aprovarReconciliacaoImagemOrfa,
  executarReconciliacaoImagemOrfa,
  listarReconciliacoesImagemOrfa,
  varrerImagensOrfasEmModoDryRun,
  type StorageOrphanReconciliationListItem,
} from '@/app/actions/storage-orphan-reconciliation'
import KnowledgeCRUD, { Artigo } from './KnowledgeCRUD'
import BusinessHoursManager from './BusinessHoursManager'
import InventoryManager from './InventoryManager'
import { StorageOrphanReconciliationPanel } from './StorageOrphanReconciliationPanel'
import PaymentProofAdminPanel from './PaymentProofAdminPanel'
import BusinessProfileCard from './BusinessProfileCard'

// Import card components and shared types
import LlmApiCard from './integrations/LlmApiCard'
import WhatsAppCard from './integrations/WhatsAppCard'
import TelegramBotCard from './integrations/TelegramBotCard'
import MercadoPagoCard from './integrations/MercadoPagoCard'
import type { FinancialOperationalMetrics } from '@/lib/admin/financial-metrics'
import { resolveBusinessProfileSync } from '@/lib/config/business-profile'

interface Usuario {
  id: string
  nome: string
  funcao: string
  ativo: boolean
  email: string | null
  telefone?: string | null
  data_criacao?: string
}

interface Estatisticas {
  totalIa: number
  totalOperador: number
  totalCliente: number
  totalMensagens: number
  taxaAutomacao: number
}

interface AuditLog {
  id: string
  usuario_id: string | null
  acao: string
  detalhes: any
  data_criacao: string
}

interface AdminDashboardProps {
  initialTab?: TabType
  usuarioLogado: {
    id: string
    nome: string
    funcao: string
    ativo: boolean
  }
  usuariosIniciais: Usuario[]
  estatisticasIniciais: Estatisticas
  logsIniciais: AuditLog[]
  artigosIniciais: Artigo[]
  systemConfigs: {
    WHATSAPP_ACCESS_TOKEN?: string
    WHATSAPP_PHONE_NUMBER_ID?: string
    WHATSAPP_APP_SECRET?: string
    WHATSAPP_VERIFY_TOKEN?: string
    EVOLUTION_API_URL?: string
    EVOLUTION_API_KEY?: string
    EVOLUTION_INSTANCE_NAME?: string
    WHATSAPP_PROVIDER?: string
    MERCADO_PAGO_ACCESS_TOKEN?: string
    MERCADO_PAGO_PUBLIC_KEY?: string
    MERCADO_PAGO_WEBHOOK_SECRET?: string
    TELEGRAM_BOT_TOKEN?: string
    SOFIA_SYSTEM_PROMPT?: string
    BUSINESS_NAME?: string
    BUSINESS_SHORT_NAME?: string
    BUSINESS_LOCATION?: string
    BUSINESS_PICKUP_ADDRESS?: string
    BUSINESS_DESCRIPTION?: string
    SOFIA_PERSONA_ROLE?: string
  }
}

type TabType = 'operadores' | 'empresa' | 'integracoes' | 'conhecimento' | 'metricas' | 'auditoria' | 'prompt' | 'horarios' | 'estoque' | 'storage-orphans' | 'comprovantes'

const allowedTabs: readonly TabType[] = ['operadores', 'empresa', 'integracoes', 'conhecimento', 'metricas', 'auditoria', 'prompt', 'horarios', 'estoque', 'storage-orphans', 'comprovantes']

export default function AdminDashboard({
  usuarioLogado,
  usuariosIniciais,
  estatisticasIniciais,
  logsIniciais,
  artigosIniciais,
  systemConfigs,
  initialTab = 'operadores',
}: AdminDashboardProps) {
  const [activeTab, setActiveTab] = useState<TabType>(
    allowedTabs.includes(initialTab) ? initialTab : 'operadores',
  )

  React.useEffect(() => {
    if (initialTab !== 'operadores' || typeof window === 'undefined') return
    const tab = new URLSearchParams(window.location.search).get('tab') as TabType
    if (tab && allowedTabs.includes(tab)) setActiveTab(tab)
  }, [initialTab])

  // State para Provedor de WhatsApp Ativo (coordenado entre cartões)
  const [provedorAtivo, setProvedorAtivo] = useState<'meta' | 'evolution'>((systemConfigs?.WHATSAPP_PROVIDER as 'meta' | 'evolution') || 'meta')
  
  // States para Operadores
  const [usuarios, setUsuarios] = useState<Usuario[]>(usuariosIniciais)
  const [searchQuery, setSearchQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState<'staff' | 'clients'>('staff')

  // States para Auditoria
  const [logSearchQuery, setLogSearchQuery] = useState('')
  const [logLevelFilter, setLogLevelFilter] = useState<'all' | 'info' | 'warning' | 'error'>('all')

  // Modal de confirmação
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean
    userId: string
    userName: string
    actionType: 'role' | 'status' | 'delete'
    targetRole?: string
    targetActive?: boolean
    currentRole?: string
    currentActive?: boolean
  }>({
    isOpen: false,
    userId: '',
    userName: '',
    actionType: 'role'
  })
  
  const [updating, setUpdating] = useState(false)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [purgeModal, setPurgeModal] = useState<{ userId: string; userName: string } | null>(null)
  const [purgePassword, setPurgePassword] = useState('')
  const [purgeConfirmation, setPurgeConfirmation] = useState('')
  const [purging, setPurging] = useState(false)
  const [purgeError, setPurgeError] = useState<string | null>(null)
  const [residuals, setResiduals] = useState<AnonymizedResidualClient[]>([])
  const [residualsExpanded, setResidualsExpanded] = useState(false)
  const [residualModal, setResidualModal] = useState<string | null>(null)
  const [residualPassword, setResidualPassword] = useState('')
  const [residualConfirmation, setResidualConfirmation] = useState('')

  // States para Modais de Edição e Criação de Usuários
  const [editUserModal, setEditUserModal] = useState<{
    isOpen: boolean
    userId: string
    nome: string
    email: string
    telefone: string
    funcao: string
    ativo: boolean
    novaSenha: string
    confirmarSenha: string
  }>({
    isOpen: false,
    userId: '',
    nome: '',
    email: '',
    telefone: '',
    funcao: 'vendedor',
    ativo: true,
    novaSenha: '',
    confirmarSenha: '',
  })
  const [savingEditUser, setSavingEditUser] = useState(false)
  const [editUserError, setEditUserError] = useState<string | null>(null)

  const [createUserModal, setCreateUserModal] = useState<{
    isOpen: boolean
    nome: string
    email: string
    senha: string
    funcao: 'admin' | 'supervisor' | 'vendedor' | 'cliente'
    telefone: string
  }>({
    isOpen: false,
    nome: '',
    email: '',
    senha: '',
    funcao: 'vendedor',
    telefone: '',
  })
  const [creatingUser, setCreatingUser] = useState(false)
  const [createUserError, setCreateUserError] = useState<string | null>(null)

  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  // States para Métricas
  const [estatisticas, setEstatisticas] = useState<Estatisticas>(estatisticasIniciais)
  const [financialMetrics, setFinancialMetrics] = useState<FinancialOperationalMetrics | null>(null)
  const [financialMetricsError, setFinancialMetricsError] = useState<string | null>(null)
  const [financialMetricsFetchedAt, setFinancialMetricsFetchedAt] = useState<string | null>(null)
  const [refreshingMetrics, setRefreshingMetrics] = useState(false)

  // States para Auditoria
  const [logs, setLogs] = useState<AuditLog[]>(logsIniciais)
  const [refreshingLogs, setRefreshingLogs] = useState(false)
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const logsPerPage = 10

  // States para Prompt
  const [copiedPrompt, setCopiedPrompt] = useState(false)

  // States para Comprovantes
  const [comprovantes, setComprovantes] = useState<any[]>([])
  const [carregandoComprovantes, setCarregandoComprovantes] = useState(false)
  const [selectedComprovante, setSelectedComprovante] = useState<any | null>(null)

  const [storageReconciliations, setStorageReconciliations] = useState<readonly StorageOrphanReconciliationListItem[]>([])
  const [storageReconciliationsLoaded, setStorageReconciliationsLoaded] = useState(false)
  const [carregandoStorageReconciliations, setCarregandoStorageReconciliations] = useState(false)
  const [storageReconciliationError, setStorageReconciliationError] = useState<string | null>(null)

  // Filtros para Comprovantes
  const [filtroClienteNome, setFiltroClienteNome] = useState('')
  const [filtroDataInicio, setFiltroDataInicio] = useState('')
  const [filtroDataFim, setFiltroDataFim] = useState('')

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message })
    setTimeout(() => setToast(null), 4000)
  }

  const carregarDadosComprovantes = React.useCallback(async () => {
    setCarregandoComprovantes(true)
    try {
      const res = await obterComprovantes({})
      if (res.success && res.data) {
        setComprovantes(res.data)
      } else {
        showToast('error', res.error || 'Falha ao carregar comprovantes.')
      }
    } catch (err) {
      console.error(err)
      showToast('error', 'Erro de conexão ao buscar comprovantes.')
    } finally {
      setCarregandoComprovantes(false)
    }
  }, [])

  React.useEffect(() => {
    if (activeTab === 'comprovantes') {
      carregarDadosComprovantes()
    }
  }, [activeTab, carregarDadosComprovantes])

  const carregarReconciliacoesImagemOrfa = React.useCallback(async () => {
    setCarregandoStorageReconciliations(true)
    setStorageReconciliationError(null)
    try {
      const res = await listarReconciliacoesImagemOrfa()
      if (res.success) {
        setStorageReconciliations(res.data)
      } else {
        setStorageReconciliations([])
        setStorageReconciliationError(res.error || 'Falha ao carregar reconciliações de imagens.')
      }
    } catch (err) {
      console.error('Erro ao buscar reconciliações de imagens órfãs:', err)
      setStorageReconciliations([])
      setStorageReconciliationError('Erro de conexão ao buscar reconciliações de imagens.')
    } finally {
      setStorageReconciliationsLoaded(true)
      setCarregandoStorageReconciliations(false)
    }
  }, [])

  const [escaneandoStorage, setEscaneandoStorage] = useState(false)

  const handleExecutarVarredura = async () => {
    setEscaneandoStorage(true)
    try {
      const res = await varrerImagensOrfasEmModoDryRun()
      if (res.success) {
        showToast('success', `Varredura concluída! ${res.discovered} descobertas, ${res.recorded} registradas.`)
        await carregarReconciliacoesImagemOrfa()
      } else {
        showToast('error', res.error || 'Erro ao executar varredura.')
      }
    } catch {
      showToast('error', 'Falha ao executar varredura de imagens órfãs.')
    } finally {
      setEscaneandoStorage(false)
    }
  }

  React.useEffect(() => {
    if (activeTab === 'storage-orphans') {
      carregarReconciliacoesImagemOrfa()
    }
  }, [activeTab, carregarReconciliacoesImagemOrfa])

  const handleSelectComprovante = (comp: any) => {
    setSelectedComprovante(comp)
  }

  const handleDownloadComprovante = async (comp: any) => {
    try {
      const supabase = createClient()
      const { data, error } = await supabase.storage
        .from('chat-midias')
        .createSignedUrl(comp.url_arquivo, 3600)

      if (error || !data?.signedUrl) {
        throw error || new Error('URL assinada não encontrada')
      }

      const res = await fetch(data.signedUrl)
      const blob = await res.blob()
      const blobUrl = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = comp.nome_arquivo || 'comprovante'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      window.URL.revokeObjectURL(blobUrl)
      showToast('success', 'Download iniciado com sucesso!')
    } catch (err: any) {
      console.error('Erro ao baixar comprovante:', err)
      showToast('error', 'Falha ao baixar o arquivo do comprovante.')
    }
  }

  const comprovantesFiltrados = comprovantes.filter(comp => {
    const nomeCliente = comp.clientes?.nome || ''
    const matchesCliente = nomeCliente.toLowerCase().includes(filtroClienteNome.toLowerCase())

    let matchesData = true
    if (filtroDataInicio) {
      const dataInicio = new Date(filtroDataInicio)
      const dataComp = new Date(comp.data_criacao)
      matchesData = matchesData && dataComp >= dataInicio
    }
    if (filtroDataFim) {
      const dataFim = new Date(filtroDataFim)
      dataFim.setHours(23, 59, 59, 999)
      const dataComp = new Date(comp.data_criacao)
      matchesData = matchesData && dataComp <= dataFim
    }

    return matchesCliente && matchesData
  })

  // --- Operações de Operadores ---
  
  const handleToggleStatusClick = (user: Usuario) => {
    if (user.id === usuarioLogado.id) return
    setUpdateError(null)
    setConfirmModal({
      isOpen: true,
      userId: user.id,
      userName: user.nome,
      actionType: 'status',
      targetActive: !user.ativo,
      targetRole: user.funcao,
      currentActive: user.ativo,
      currentRole: user.funcao
    })
  }

  const handleRoleChangeClick = (user: Usuario, nextRole: string) => {
    if (user.id === usuarioLogado.id) return
    setUpdateError(null)
    setConfirmModal({
      isOpen: true,
      userId: user.id,
      userName: user.nome,
      actionType: 'role',
      targetActive: user.ativo,
      targetRole: nextRole,
      currentActive: user.ativo,
      currentRole: user.funcao
    })
  }

  const handleDeleteUserClick = (user: Usuario) => {
    if (user.id === usuarioLogado.id) return
    setUpdateError(null)
    setConfirmModal({
      isOpen: true,
      userId: user.id,
      userName: user.nome,
      actionType: 'delete',
      targetActive: false,
      targetRole: user.funcao,
      currentActive: user.ativo,
      currentRole: user.funcao
    })
  }

  const loadResiduals = async () => { const result = await listarRegistrosAnonimizadosPreservados(); if (result.success) setResiduals(result.data) }
  React.useEffect(() => { if (activeTab === 'operadores') void loadResiduals() }, [activeTab])
  const purgeResidual = async () => { if (!residualModal) return; const result = await purgarResidualClienteAdmin({ clienteId: residualModal, senhaAtual: residualPassword, confirmacao: residualConfirmation }); if (result.success) { setResiduals((rows) => rows.filter((row) => row.id !== residualModal)); setResidualModal(null); setResidualPassword(''); setResidualConfirmation(''); showToast('success','Registro anonimizado purgado.') } else setPurgeError(result.error || 'Purga residual indisponível.') }

  const handleTotalPurge = async () => {
    if (!purgeModal) return
    setPurging(true)
    setPurgeError(null)
    try {
      const result = await purgarUsuarioAdminTotal({
        usuarioAlvoId: purgeModal.userId,
        senhaAtual: purgePassword,
        confirmacao: purgeConfirmation,
      })
      if (!result.success) {
        setPurgeError(result.error || 'A purga não pôde ser concluída.')
        return
      }
      setUsuarios((current) => current.filter((user) => user.id !== purgeModal.userId))
      setPurgeModal(null)
      setPurgePassword('')
      setPurgeConfirmation('')
      showToast('success', 'Purga total concluída.')
      handleRefreshLogsSilent()
    } finally {
      setPurging(false)
    }
  }

  const handleConfirmUpdate = async () => {
    setUpdating(true)
    setUpdateError(null)
    try {
      const { userId, targetRole, targetActive, actionType } = confirmModal

      if (actionType === 'delete') {
        const res = await deletarUsuarioAdmin(userId)
        if (res.success) {
          setUsuarios(prev => prev.filter(u => u.id !== userId))
          showToast('success', `Operador ${confirmModal.userName} e todos os seus dados foram excluídos com sucesso.`)
          setConfirmModal(prev => ({ ...prev, isOpen: false }))
          handleRefreshLogsSilent()
        } else {
          let msg = 'Erro desconhecido ao excluir operador.'
          if (res.error === 'ANTI_LOCKOUT') {
            msg = 'Não é permitido excluir o próprio usuário logado (Anti-Lockout).'
          } else if (res.error === 'MINIMO_UM_ADMIN_ATIVO') {
            msg = 'Exclusão rejeitada. É necessário manter ao menos um Administrador ativo no sistema.'
          } else {
            msg = res.error || msg
          }
          setUpdateError(msg)
        }
        return
      }

      if (!targetRole) return

      const res = await atualizarPerfilUsuario(userId, targetRole, targetActive ?? true)
      
      if (res.success) {
        // Atualiza localmente
        setUsuarios(prev =>
          prev.map(u => (u.id === userId ? { ...u, funcao: targetRole, ativo: targetActive ?? true } : u))
        )
        showToast('success', `Operador ${confirmModal.userName} atualizado com sucesso.`)
        setConfirmModal(prev => ({ ...prev, isOpen: false }))
        
        // Auto-recarrega os logs de auditoria caso a aba de auditoria precise ser atualizada
        handleRefreshLogsSilent()
      } else {
        let msg = 'Erro desconhecido ao atualizar operador.'
        if (res.error === 'ANTI_LOCKOUT') {
          msg = 'Não é permitido alterar ou desativar o próprio usuário logado (Anti-Lockout).'
        } else if (res.error === 'MINIMO_UM_ADMIN_ATIVO') {
          msg = 'Alteração rejeitada. É necessário manter ao menos um Administrador ativo no sistema.'
        } else {
          msg = res.error || msg
        }
        setUpdateError(msg)
      }
    } catch (err: any) {
      console.error(err)
      setUpdateError('Erro interno de conexão. Tente novamente.')
    } finally {
      setUpdating(false)
    }
  }

  const handleEditUserClick = (user: Usuario) => {
    setEditUserError(null)
    setEditUserModal({
      isOpen: true,
      userId: user.id,
      nome: user.nome || '',
      email: user.email || '',
      telefone: user.telefone || '',
      funcao: user.funcao || 'vendedor',
      ativo: user.ativo ?? true,
      novaSenha: '',
      confirmarSenha: '',
    })
  }

  const handleSaveEditUser = async (e: React.FormEvent) => {
    e.preventDefault()
    setSavingEditUser(true)
    setEditUserError(null)
    try {
      if (!editUserModal.nome.trim()) {
        setEditUserError('O nome do usuário é obrigatório.')
        setSavingEditUser(false)
        return
      }

      if (editUserModal.novaSenha || editUserModal.confirmarSenha) {
        if (editUserModal.novaSenha.trim().length < 6) {
          setEditUserError('A nova senha deve possuir ao menos 6 caracteres.')
          setSavingEditUser(false)
          return
        }

        if (editUserModal.novaSenha !== editUserModal.confirmarSenha) {
          setEditUserError('As senhas digitadas não coincidem. Verifique a confirmação de senha.')
          setSavingEditUser(false)
          return
        }
      }

      const res = await editarUsuarioAdmin(editUserModal.userId, {
        nome: editUserModal.nome,
        email: editUserModal.email || undefined,
        telefone: editUserModal.telefone || undefined,
        funcao: editUserModal.funcao,
        ativo: editUserModal.ativo,
        novaSenha: editUserModal.novaSenha || undefined,
      })

      if (res.success) {
        setUsuarios(prev =>
          prev.map(u =>
            u.id === editUserModal.userId
              ? {
                  ...u,
                  nome: editUserModal.nome.trim(),
                  email: editUserModal.email ? editUserModal.email.trim().toLowerCase() : u.email,
                  telefone: editUserModal.telefone ? editUserModal.telefone.trim() : u.telefone,
                  funcao: editUserModal.funcao,
                  ativo: editUserModal.ativo,
                }
              : u
          )
        )
        showToast('success', `Dados do usuário "${editUserModal.nome}" atualizados com sucesso!`)
        setEditUserModal(prev => ({ ...prev, isOpen: false }))
        handleRefreshLogsSilent()
      } else {
        let msg = 'Erro ao atualizar dados do usuário.'
        if (res.error === 'ANTI_LOCKOUT') {
          msg = 'Ação bloqueada: Não é permitido desativar ou rebaixar a sua própria conta de Administrador logada.'
        } else if (res.error === 'MINIMO_UM_ADMIN_ATIVO') {
          msg = 'Alteração rejeitada: O sistema exige a permanência de ao menos um Administrador ativo.'
        } else if (res.error === 'SENHA_MINIMA_6_CARACTERES') {
          msg = 'A nova senha deve ter no mínimo 6 caracteres.'
        } else {
          msg = res.error || msg
        }
        setEditUserError(msg)
      }
    } catch (err: any) {
      setEditUserError(err.message || 'Erro inesperado ao salvar alterações do usuário.')
    } finally {
      setSavingEditUser(false)
    }
  }

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault()
    setCreatingUser(true)
    setCreateUserError(null)
    try {
      if (!createUserModal.nome.trim() || !createUserModal.email.trim() || !createUserModal.senha.trim()) {
        setCreateUserError('Preencha os campos obrigatórios (Nome, E-mail e Senha).')
        setCreatingUser(false)
        return
      }

      if (createUserModal.senha.length < 6) {
        setCreateUserError('A senha provisória deve conter no mínimo 6 caracteres.')
        setCreatingUser(false)
        return
      }

      const res = await criarUsuarioAdmin({
        nome: createUserModal.nome,
        email: createUserModal.email,
        senha: createUserModal.senha,
        funcao: createUserModal.funcao,
        telefone: createUserModal.telefone || undefined,
      })

      if (res.success && res.usuario) {
        setUsuarios(prev => [res.usuario, ...prev])
        showToast('success', `Membro "${createUserModal.nome}" cadastrado com sucesso!`)
        setCreateUserModal({
          isOpen: false,
          nome: '',
          email: '',
          senha: '',
          funcao: 'vendedor',
          telefone: '',
        })
        handleRefreshLogsSilent()
      } else {
        setCreateUserError(res.error || 'Erro ao cadastrar novo membro.')
      }
    } catch (err: any) {
      setCreateUserError(err.message || 'Erro inesperado ao cadastrar usuário.')
    } finally {
      setCreatingUser(false)
    }
  }

  // --- Ações de Métricas ---

  const carregarMetricasFinanceiras = React.useCallback(async () => {
    const endAt = new Date()
    const startAt = new Date(endAt.getTime() - 30 * 24 * 60 * 60 * 1000)
    try {
      const res = await obterMetricasFinanceirasOperacionais({ startAt: startAt.toISOString(), endAt: endAt.toISOString() })
      if (res.success) {
        setFinancialMetrics(res.data)
        setFinancialMetricsFetchedAt(res.fetchedAt)
        setFinancialMetricsError(null)
      } else setFinancialMetricsError('Métricas financeiras indisponíveis. Atualize para tentar novamente.')
    } catch {
      setFinancialMetricsError('Métricas financeiras indisponíveis. Atualize para tentar novamente.')
    }
  }, [])

  React.useEffect(() => {
    if (activeTab === 'metricas') carregarMetricasFinanceiras()
  }, [activeTab, carregarMetricasFinanceiras])

  const handleRefreshMetrics = async () => {
    setRefreshingMetrics(true)
    try {
      const [chat] = await Promise.all([obterEstatisticasMensagens(), carregarMetricasFinanceiras()])
      if (chat.success && chat.data) {
        setEstatisticas(chat.data)
        showToast('success', 'Métricas de atendimento atualizadas.')
      } else showToast('error', 'Falha ao buscar novas métricas.')
    } catch {
      showToast('error', 'Erro ao processar métricas.')
    } finally {
      setRefreshingMetrics(false)
    }
  }

  // --- Ações de Auditoria ---

  const handleRefreshLogs = async () => {
    setRefreshingLogs(true)
    try {
      const res = await obterLogsAuditoria(100)
      if (res.success && res.data) {
        setLogs(res.data)
        showToast('success', 'Logs de auditoria recarregados.')
        setCurrentPage(1)
      } else {
        showToast('error', 'Falha ao buscar logs de auditoria.')
      }
    } catch {
      showToast('error', 'Erro de conexão ao buscar logs.')
    } finally {
      setRefreshingLogs(false)
    }
  }

  const handleRefreshLogsSilent = async () => {
    try {
      const res = await obterLogsAuditoria(100)
      if (res.success && res.data) {
        setLogs(res.data)
      }
    } catch (err) {
      console.error('Erro ao atualizar logs silêncio:', err)
    }
  }

  // --- Ações de Prompt ---

  const defaultProfile = resolveBusinessProfileSync()
  const businessName = systemConfigs?.BUSINESS_NAME || defaultProfile.name
  const businessLocation = systemConfigs?.BUSINESS_LOCATION || defaultProfile.location
  const personaRole = systemConfigs?.SOFIA_PERSONA_ROLE || (businessName === defaultProfile.name ? 'assistente virtual amigável' : defaultProfile.personaRole)

  const systemPromptStatic = `Você é a Sofía, ${personaRole} da ${businessName} em ${businessLocation}.
Sua personalidade é acolhedora, simpática, com leve sotaque e gírias curitibanas (use termos como "piá", "daí" de forma natural e sem exageros).
Você deve usar emojis com moderação (no máximo 1 ou 2 por mensagem).

DIRETRIZES RÍGIDAS DE COMPORTAMENTO:
1. Responda apenas com base no CONTEXTO DE SUPORTE fornecido abaixo.
2. Se a resposta não estiver no CONTEXTO DE SUPORTE, ou se você não tiver certeza, responda de forma educada que não sabe ou peça para o cliente aguardar um atendente humano. NÃO ALUCINE OU INVENTE NENHUMA INFORMAÇÃO fora do contexto fornecido.
3. Responda em Português do Brasil (pt-BR).
4. Suas respostas devem ser breves e direto ao ponto.`

  const [promptValue, setPromptValue] = useState(systemConfigs?.SOFIA_SYSTEM_PROMPT || systemPromptStatic)
  const [savingPrompt, setSavingPrompt] = useState(false)

  const handleCopyPrompt = () => {
    navigator.clipboard.writeText(promptValue)
    setCopiedPrompt(true)
    showToast('success', 'Prompt copiado para a área de transferência.')
    setTimeout(() => setCopiedPrompt(false), 2000)
  }

  const handleSavePrompt = async () => {
    setSavingPrompt(true)
    try {
      const res = await salvarConfiguracaoAdmin('SOFIA_SYSTEM_PROMPT', promptValue)
      if (res.success) {
        showToast('success', 'Master System Prompt salvo com sucesso!')
      } else {
        showToast('error', res.error || 'Erro ao salvar o prompt.')
      }
    } catch (err: any) {
      console.error(err)
      showToast('error', 'Erro interno ao salvar o prompt.')
    } finally {
      setSavingPrompt(false)
    }
  }


  function getLogLevel(acao: string, detalhes: any): 'info' | 'warning' | 'error' {
    const hasError = detalhes && (
      detalhes.sucesso === false ||
      detalhes.success === false ||
      detalhes.connected === false ||
      !!detalhes.erro ||
      !!detalhes.error
    )
    if (hasError) return 'error'

    if (['excluir_usuario', 'alternar_sofia_global'].includes(acao)) {
      return 'warning'
    }

    if (acao === 'atualizar_perfil') {
      if (detalhes?.novo_ativo === false || detalhes?.nova_funcao === 'admin') {
        return 'warning'
      }
    }

    if (acao === 'salvar_configuracao') {
      return 'warning'
    }

    return 'info'
  }

  // Paginação de Logs
  const filteredLogs = logs.filter(log => {
    const op = usuarios.find(u => u.id === log.usuario_id)
    const operatorName = op ? op.nome : 'Sistema / Anon'
    const actionName = formatActionName(log.acao)

    const matchesSearch = 
      operatorName.toLowerCase().includes(logSearchQuery.toLowerCase()) ||
      actionName.toLowerCase().includes(logSearchQuery.toLowerCase()) ||
      log.acao.toLowerCase().includes(logSearchQuery.toLowerCase())

    if (!matchesSearch) return false

    if (logLevelFilter !== 'all') {
      const level = getLogLevel(log.acao, log.detalhes)
      return level === logLevelFilter
    }

    return true
  })

  const totalPages = Math.ceil(filteredLogs.length / logsPerPage)
  const paginatedLogs = filteredLogs.slice((currentPage - 1) * logsPerPage, currentPage * logsPerPage)

  const filteredUsuarios = usuarios.filter(u => {
    const matchesSearch =
      u.nome.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (u.email && u.email.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (u.telefone && u.telefone.toLowerCase().includes(searchQuery.toLowerCase()))
    
    if (!matchesSearch) return false

    if (roleFilter === 'staff') {
      return u.funcao === 'admin' || u.funcao === 'supervisor' || u.funcao === 'vendedor'
    } else {
      return u.funcao === 'cliente'
    }
  })

  function formatActionName(acao: string) {
    switch (acao) {
      case 'atualizar_perfil':
        return 'Alteração de Perfil'
      default:
        return acao
    }
  }

  // Componente de Switch Customizado
  const ToggleButton = ({
    checked,
    onChange,
    disabled
  }: {
    checked: boolean
    onChange: () => void
    disabled?: boolean
  }) => {
    return (
      <button
        type="button"
        onClick={onChange}
        disabled={disabled}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed ${
          checked ? 'bg-amber-500' : 'bg-zinc-700'
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-zinc-950 shadow-lg ring-0 transition duration-200 ease-in-out ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    )
  }

  return (
    <div className="flex h-full w-full bg-zinc-950 text-zinc-200">
      
      {/* Toast Alert */}
      {toast && (
        <div
          className={`fixed right-6 top-24 z-[100] flex items-center gap-3 rounded-2xl border px-4 py-3.5 shadow-2xl backdrop-blur-md transition-all duration-300 transform scale-100 translate-y-0 ${
            toast.type === 'success'
              ? 'bg-zinc-900/95 border-emerald-500/30 text-emerald-400 shadow-emerald-950/20'
              : 'bg-zinc-900/95 border-rose-500/30 text-rose-400 shadow-rose-950/20'
          } animate-fade-in`}
        >
          <div className={`p-1.5 rounded-lg ${toast.type === 'success' ? 'bg-emerald-500/10' : 'bg-rose-500/10'}`}>
            {toast.type === 'success' ? (
              <CheckCircle2 className="h-4.5 w-4.5 shrink-0" />
            ) : (
              <AlertTriangle className="h-4.5 w-4.5 shrink-0" />
            )}
          </div>
          <span className="text-xs font-bold text-zinc-100 tracking-wide pr-2">{toast.message}</span>
        </div>
      )}

      {purgeModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-md rounded-2xl border border-rose-500/40 bg-zinc-900 p-6 shadow-2xl">
            <h3 className="text-base font-bold text-rose-300">Purga total — apenas conta de teste</h3>
            <p className="mt-3 text-xs leading-relaxed text-zinc-300">Remove definitivamente todos os dados derivados de {purgeModal.userName}, incluindo pedidos, conversas, comprovantes e arquivos atribuíveis. Registros financeiros e auditoria da exclusão normal NÃO são preservados. Arquivos legados ambíguos ficam na reconciliação de órfãos.</p>
            <label className="mt-4 block text-xs font-semibold text-zinc-300">Senha atual do administrador<input autoComplete="current-password" className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm" onChange={(event) => setPurgePassword(event.target.value)} type="password" value={purgePassword} /></label>
            <label className="mt-3 block text-xs font-semibold text-zinc-300">Digite PURGAR DEFINITIVAMENTE<input className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm" onChange={(event) => setPurgeConfirmation(event.target.value)} value={purgeConfirmation} /></label>
            {purgeError ? <p className="mt-3 text-xs text-rose-300">{purgeError}</p> : null}
            <div className="mt-5 flex justify-end gap-3"><button className="rounded-lg border border-zinc-700 px-3 py-2 text-xs" disabled={purging} onClick={() => { setPurgeModal(null); setPurgePassword(''); setPurgeConfirmation('') }}>Cancelar</button><button className="rounded-lg bg-rose-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50" disabled={purging || purgeConfirmation !== 'PURGAR DEFINITIVAMENTE' || !purgePassword} onClick={handleTotalPurge}>{purging ? 'Purgando...' : 'Executar purga total'}</button></div>
          </div>
        </div>
      )}

      {/* Confirmation Modal */}
      {confirmModal.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-fade-in">
          <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/95 p-6 shadow-2xl animate-scale-up backdrop-blur-md">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2.5 text-amber-500">
                <AlertTriangle className="h-5.5 w-5.5" />
                <h3 className="text-sm font-bold text-zinc-100 tracking-tight">Confirmar Ação Crítica</h3>
              </div>
              <button
                onClick={() => setConfirmModal(prev => ({ ...prev, isOpen: false }))}
                className="text-zinc-500 hover:text-zinc-300 p-1 rounded-lg hover:bg-zinc-800/40 transition-all"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            
            <div className="text-sm text-zinc-300 space-y-3 mb-6">
              <p className="text-xs text-zinc-400 leading-relaxed">
                {confirmModal.actionType === 'delete'
                  ? 'A exclusão normal remove acesso e anonimiza dados pessoais, preservando pedidos, pagamentos, comprovantes e auditoria:'
                  : 'Você está alterando as permissões de acesso do operador:'}
              </p>
              <div className="p-4 bg-zinc-950/60 rounded-xl border border-zinc-800/60">
                <p className="font-bold text-sm text-zinc-100">{confirmModal.userName}</p>
                {confirmModal.actionType === 'status' ? (
                  <p className="text-xs text-zinc-400 mt-2 flex items-center gap-1.5">
                    Status: <span className={confirmModal.currentActive ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'}>{confirmModal.currentActive ? 'Ativo' : 'Inativo'}</span>
                    <span className="text-zinc-600">→</span>
                    <span className={confirmModal.targetActive ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'}>{confirmModal.targetActive ? 'Ativo' : 'Inativo'}</span>
                  </p>
                ) : confirmModal.actionType === 'role' ? (
                  <p className="text-xs text-zinc-400 mt-2 flex items-center gap-1.5">
                    Função: <span className="capitalize text-zinc-300 font-semibold">{confirmModal.currentRole}</span>
                    <span className="text-zinc-600">→</span>
                    <span className="capitalize text-amber-500 font-bold">{confirmModal.targetRole}</span>
                  </p>
                ) : (
                  <p className="text-[11px] text-rose-400 mt-2 font-medium leading-relaxed">
                    Pedidos, pagamentos, comprovantes, provas e auditoria permanecem anonimizados. Use a Purga total somente para conta de teste.
                  </p>
                )}
              </div>
              {confirmModal.actionType === 'status' && !confirmModal.targetActive && (
                <p className="text-[11px] text-rose-400/90 font-medium">
                  * Importante: Desativar este operador impedirá que ele acesse qualquer console de atendimento.
                </p>
              )}
              {confirmModal.actionType === 'delete' && (
                <p className="text-[11px] text-rose-500 font-bold uppercase tracking-wider">
                  ⚠️ A conta de acesso será removida; os registros preservados ficarão anonimizados.
                </p>
              )}
            </div>

            {updateError && (
              <div className="mb-4 rounded-xl bg-rose-500/10 border border-rose-500/20 p-3 text-xs text-rose-400 font-medium">
                {updateError}
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2 border-t border-zinc-800/40">
              <button
                onClick={() => setConfirmModal(prev => ({ ...prev, isOpen: false }))}
                disabled={updating}
                className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-2.5 text-xs font-semibold text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors cursor-pointer disabled:opacity-50 active:scale-95"
              >
                Cancelar
              </button>
              <button
                onClick={handleConfirmUpdate}
                disabled={updating}
                className={`flex items-center gap-1.5 rounded-xl px-5 py-2.5 text-xs font-bold active:scale-95 transition-all cursor-pointer disabled:opacity-50 ${
                  confirmModal.actionType === 'delete'
                    ? 'bg-rose-600 hover:bg-rose-500 text-zinc-100 shadow-lg shadow-rose-950/20'
                    : 'bg-amber-500 hover:bg-amber-600 text-zinc-950 shadow-lg shadow-amber-500/10'
                }`}
              >
                {updating && <Loader2 className="h-3 w-3 animate-spin text-current" />}
                {confirmModal.actionType === 'delete' ? 'Excluir e anonimizar' : 'Confirmar Alteração'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit User Modal */}
      {editUserModal.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-fade-in">
          <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900/95 p-6 shadow-2xl animate-scale-up backdrop-blur-md">
            <div className="flex items-center justify-between mb-5 border-b border-zinc-800/80 pb-4">
              <div className="flex items-center gap-2.5 text-amber-500">
                <Edit3 className="h-5 w-5" />
                <h3 className="text-base font-bold text-zinc-100 tracking-tight">Editar Dados do Usuário</h3>
              </div>
              <button
                onClick={() => setEditUserModal(prev => ({ ...prev, isOpen: false }))}
                className="text-zinc-500 hover:text-zinc-300 p-1.5 rounded-lg hover:bg-zinc-800/40 transition-all"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSaveEditUser} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                  <User className="h-3.5 w-3.5 text-amber-400" />
                  Nome Completo
                </label>
                <input
                  type="text"
                  required
                  value={editUserModal.nome}
                  onChange={e => setEditUserModal(prev => ({ ...prev, nome: e.target.value }))}
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3.5 py-2.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-amber-500 focus:outline-none"
                  placeholder="Nome do operador"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                    <Mail className="h-3.5 w-3.5 text-zinc-400" />
                    E-mail
                  </label>
                  <input
                    type="email"
                    value={editUserModal.email}
                    onChange={e => setEditUserModal(prev => ({ ...prev, email: e.target.value }))}
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3.5 py-2.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-amber-500 focus:outline-none"
                    placeholder="email@exemplo.com"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                    <Phone className="h-3.5 w-3.5 text-amber-400" />
                    Telefone de Acesso (Login)
                  </label>
                  <input
                    type="text"
                    disabled
                    readOnly
                    value={editUserModal.telefone || 'Sem telefone cadastrado'}
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-950/70 px-3.5 py-2.5 text-xs text-amber-400 font-mono font-bold cursor-not-allowed select-all shadow-inner"
                    title="O telefone de acesso não pode ser alterado pois é a chave de login do cliente"
                  />
                  <p className="text-[10px] text-zinc-500">
                    O telefone é a chave de acesso (login) e não pode ser alterado.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-zinc-300">Função no Sistema</label>
                  <select
                    value={editUserModal.funcao}
                    onChange={e => setEditUserModal(prev => ({ ...prev, funcao: e.target.value }))}
                    disabled={editUserModal.userId === usuarioLogado.id}
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3.5 py-2.5 text-xs text-zinc-100 focus:border-amber-500 focus:outline-none capitalize disabled:opacity-50"
                  >
                    <option value="admin">Administrador</option>
                    <option value="supervisor">Supervisor</option>
                    <option value="vendedor">Vendedor</option>
                    <option value="cliente">Cliente</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-zinc-300">Status da Conta</label>
                  <select
                    value={editUserModal.ativo ? 'true' : 'false'}
                    onChange={e => setEditUserModal(prev => ({ ...prev, ativo: e.target.value === 'true' }))}
                    disabled={editUserModal.userId === usuarioLogado.id}
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3.5 py-2.5 text-xs text-zinc-100 focus:border-amber-500 focus:outline-none disabled:opacity-50"
                  >
                    <option value="true">Ativo</option>
                    <option value="false">Inativo (Bloqueado)</option>
                  </select>
                </div>
              </div>

              <div className="space-y-3 pt-3 border-t border-zinc-800/60">
                <label className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                  <Lock className="h-3.5 w-3.5 text-amber-400" />
                  Redefinir Senha de Acesso
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <span className="text-[11px] text-zinc-400 font-medium">Nova Senha</span>
                    <input
                      type="password"
                      value={editUserModal.novaSenha}
                      onChange={e => setEditUserModal(prev => ({ ...prev, novaSenha: e.target.value }))}
                      className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3.5 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-amber-500 focus:outline-none"
                      placeholder="Nova senha (mín. 6 caracteres)"
                    />
                  </div>
                  <div className="space-y-1">
                    <span className="text-[11px] text-zinc-400 font-medium">Confirmar Nova Senha</span>
                    <input
                      type="password"
                      value={editUserModal.confirmarSenha}
                      onChange={e => setEditUserModal(prev => ({ ...prev, confirmarSenha: e.target.value }))}
                      className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3.5 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-amber-500 focus:outline-none"
                      placeholder="Repita a nova senha"
                    />
                  </div>
                </div>
                <p className="text-[11px] text-zinc-500">
                  Deixe ambos os campos em branco caso não deseje alterar a senha do usuário.
                </p>
              </div>

              {editUserError && (
                <div className="rounded-xl bg-rose-500/10 border border-rose-500/20 p-3 text-xs text-rose-400 font-medium">
                  {editUserError}
                </div>
              )}

              <div className="flex justify-end gap-3 pt-3 border-t border-zinc-800/40">
                <button
                  type="button"
                  onClick={() => setEditUserModal(prev => ({ ...prev, isOpen: false }))}
                  disabled={savingEditUser}
                  className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-2.5 text-xs font-semibold text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors cursor-pointer disabled:opacity-50 active:scale-95"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={savingEditUser}
                  className="flex items-center gap-1.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-zinc-950 px-5 py-2.5 text-xs font-bold shadow-lg shadow-amber-500/10 active:scale-95 transition-all cursor-pointer disabled:opacity-50"
                >
                  {savingEditUser && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-950" />}
                  Salvar Alterações
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create User Modal */}
      {createUserModal.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-fade-in">
          <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900/95 p-6 shadow-2xl animate-scale-up backdrop-blur-md">
            <div className="flex items-center justify-between mb-5 border-b border-zinc-800/80 pb-4">
              <div className="flex items-center gap-2.5 text-amber-500">
                <UserPlus className="h-5 w-5" />
                <h3 className="text-base font-bold text-zinc-100 tracking-tight">Cadastrar Novo Membro da Equipe</h3>
              </div>
              <button
                onClick={() => setCreateUserModal(prev => ({ ...prev, isOpen: false }))}
                className="text-zinc-500 hover:text-zinc-300 p-1.5 rounded-lg hover:bg-zinc-800/40 transition-all"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleCreateUser} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                  <User className="h-3.5 w-3.5 text-amber-400" />
                  Nome Completo *
                </label>
                <input
                  type="text"
                  required
                  value={createUserModal.nome}
                  onChange={e => setCreateUserModal(prev => ({ ...prev, nome: e.target.value }))}
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3.5 py-2.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-amber-500 focus:outline-none"
                  placeholder="Ex: Carlos Oliveira"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                  <Mail className="h-3.5 w-3.5 text-zinc-400" />
                  E-mail de Acesso *
                </label>
                <input
                  type="email"
                  required
                  value={createUserModal.email}
                  onChange={e => setCreateUserModal(prev => ({ ...prev, email: e.target.value }))}
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3.5 py-2.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-amber-500 focus:outline-none"
                  placeholder="carlos@crmsofiamanager.com.br"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                    <Lock className="h-3.5 w-3.5 text-amber-400" />
                    Senha Provisória *
                  </label>
                  <input
                    type="password"
                    required
                    value={createUserModal.senha}
                    onChange={e => setCreateUserModal(prev => ({ ...prev, senha: e.target.value }))}
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3.5 py-2.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-amber-500 focus:outline-none"
                    placeholder="Mínimo 6 dígitos"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-zinc-300">Função</label>
                  <select
                    value={createUserModal.funcao}
                    onChange={e => setCreateUserModal(prev => ({ ...prev, funcao: e.target.value as any }))}
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3.5 py-2.5 text-xs text-zinc-100 focus:border-amber-500 focus:outline-none capitalize"
                  >
                    <option value="vendedor">Vendedor (Atendente)</option>
                    <option value="supervisor">Supervisor</option>
                    <option value="admin">Administrador</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                  <Phone className="h-3.5 w-3.5 text-zinc-400" />
                  Telefone / WhatsApp (Opcional)
                </label>
                <input
                  type="text"
                  value={createUserModal.telefone}
                  onChange={e => setCreateUserModal(prev => ({ ...prev, telefone: e.target.value }))}
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3.5 py-2.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-amber-500 focus:outline-none font-mono"
                  placeholder="55419XXXXXXXX"
                />
              </div>

              {createUserError && (
                <div className="rounded-xl bg-rose-500/10 border border-rose-500/20 p-3 text-xs text-rose-400 font-medium">
                  {createUserError}
                </div>
              )}

              <div className="flex justify-end gap-3 pt-3 border-t border-zinc-800/40">
                <button
                  type="button"
                  onClick={() => setCreateUserModal(prev => ({ ...prev, isOpen: false }))}
                  disabled={creatingUser}
                  className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-2.5 text-xs font-semibold text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors cursor-pointer disabled:opacity-50 active:scale-95"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={creatingUser}
                  className="flex items-center gap-1.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-zinc-950 px-5 py-2.5 text-xs font-bold shadow-lg shadow-amber-500/10 active:scale-95 transition-all cursor-pointer disabled:opacity-50"
                >
                  {creatingUser && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-950" />}
                  Cadastrar Membro
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Sidebar Navigation */}
      <aside className="w-72 shrink-0 border-r border-zinc-800/80 bg-zinc-950/80 p-5 flex flex-col justify-between backdrop-blur-md overflow-y-auto">
        <div className="space-y-6">
          <nav className="space-y-5">
            {/* Categoria 1: Operacional & Vendas */}
            <div className="space-y-1">
              <div className="px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-amber-500/90 flex items-center gap-1.5">
                <span>🥩</span>
                <span>Operacional & Vendas</span>
              </div>

              <button
                onClick={() => setActiveTab('estoque')}
                className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-xs font-semibold transition-all cursor-pointer ${
                  activeTab === 'estoque'
                    ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30 shadow-sm shadow-amber-500/10'
                    : 'text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'
                }`}
              >
                <Package className="h-4 w-4 shrink-0" />
                <span>Estoque & Combos</span>
              </button>

              <button
                onClick={() => setActiveTab('horarios')}
                className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-xs font-semibold transition-all cursor-pointer ${
                  activeTab === 'horarios'
                    ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30 shadow-sm shadow-amber-500/10'
                    : 'text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'
                }`}
              >
                <Clock className="h-4 w-4 shrink-0" />
                <span>Horários & Retiradas</span>
              </button>

              <button
                onClick={() => setActiveTab('comprovantes')}
                className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-xs font-semibold transition-all cursor-pointer ${
                  activeTab === 'comprovantes'
                    ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30 shadow-sm shadow-amber-500/10'
                    : 'text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'
                }`}
              >
                <FileText className="h-4 w-4 shrink-0" />
                <span>Comprovantes PIX</span>
              </button>
            </div>

            {/* Categoria 2: Inteligência Artificial & Sofia CRM */}
            <div className="space-y-1">
              <div className="px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-amber-500/90 flex items-center gap-1.5">
                <span>🤖</span>
                <span>Inteligência & Sofía CRM</span>
              </div>

              <button
                onClick={() => setActiveTab('prompt')}
                className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-xs font-semibold transition-all cursor-pointer ${
                  activeTab === 'prompt'
                    ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30 shadow-sm shadow-amber-500/10'
                    : 'text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'
                }`}
              >
                <Bot className="h-4 w-4 shrink-0" />
                <span>Prompt Mestre da Sofía</span>
              </button>

              <button
                onClick={() => setActiveTab('conhecimento')}
                className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-xs font-semibold transition-all cursor-pointer ${
                  activeTab === 'conhecimento'
                    ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30 shadow-sm shadow-amber-500/10'
                    : 'text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'
                }`}
              >
                <BookOpen className="h-4 w-4 shrink-0" />
                <span>Base de Conhecimento RAG</span>
              </button>

              <button
                onClick={() => setActiveTab('integracoes')}
                className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-xs font-semibold transition-all cursor-pointer ${
                  activeTab === 'integracoes'
                    ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30 shadow-sm shadow-amber-500/10'
                    : 'text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'
                }`}
              >
                <Calendar className="h-4 w-4 shrink-0" />
                <span>Canais & Integrações</span>
              </button>
            </div>

            {/* Categoria 3: Governança & Gestão */}
            <div className="space-y-1">
              <div className="px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-amber-500/90 flex items-center gap-1.5">
                <span>🛡️</span>
                <span>Governança & Gestão</span>
              </div>

              <button
                onClick={() => setActiveTab('operadores')}
                className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-xs font-semibold transition-all cursor-pointer ${
                  activeTab === 'operadores'
                    ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30 shadow-sm shadow-amber-500/10'
                    : 'text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'
                }`}
              >
                <Users className="h-4 w-4 shrink-0" />
                <span>Usuários & Equipe</span>
              </button>

              <button
                onClick={() => setActiveTab('empresa')}
                className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-xs font-semibold transition-all cursor-pointer ${
                  activeTab === 'empresa'
                    ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30 shadow-sm shadow-amber-500/10'
                    : 'text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'
                }`}
              >
                <Building2 className="h-4 w-4 shrink-0" />
                <span>Perfil da Empresa</span>
              </button>

              <button
                onClick={() => setActiveTab('metricas')}
                className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-xs font-semibold transition-all cursor-pointer ${
                  activeTab === 'metricas'
                    ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30 shadow-sm shadow-amber-500/10'
                    : 'text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'
                }`}
              >
                <BarChart3 className="h-4 w-4 shrink-0" />
                <span>Métricas & Desempenho</span>
              </button>

              <button
                onClick={() => setActiveTab('auditoria')}
                className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-xs font-semibold transition-all cursor-pointer ${
                  activeTab === 'auditoria'
                    ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30 shadow-sm shadow-amber-500/10'
                    : 'text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'
                }`}
              >
                <Activity className="h-4 w-4 shrink-0" />
                <span>Auditoria & Segurança</span>
              </button>

              <button
                onClick={() => setActiveTab('storage-orphans')}
                className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-xs font-semibold transition-all cursor-pointer ${
                  activeTab === 'storage-orphans'
                    ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30 shadow-sm shadow-amber-500/10'
                    : 'text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'
                }`}
              >
                <ShieldCheck className="h-4 w-4 shrink-0" />
                <span>Reconciliação de imagens</span>
              </button>
            </div>
          </nav>
        </div>
        
        <div className="space-y-3 pt-6 border-t border-zinc-800/80">
          {/* Info logado */}
          <div className="rounded-xl bg-zinc-900/50 border border-zinc-800/60 p-3 text-xs">
            <div className="text-zinc-500 font-medium text-[11px]">Operador Ativo</div>
            <div className="font-bold text-zinc-200 mt-0.5 truncate">{usuarioLogado.nome}</div>
            <div className="text-amber-500 font-semibold mt-0.5 capitalize text-[10px] tracking-wide">
              Função: {usuarioLogado.funcao === 'admin' ? 'Administrador' : usuarioLogado.funcao === 'supervisor' ? 'Supervisor' : 'Atendente'}
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <section className="flex-1 min-w-0 flex flex-col overflow-hidden bg-zinc-950 p-4 md:p-8">
        {/* Top Operational Quick Bar */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-gradient-to-r from-zinc-900/80 via-zinc-900/40 to-zinc-900/80 p-4 border border-zinc-800/80 backdrop-blur-md shrink-0">
          <div className="flex items-center gap-3">
            <span className="flex h-3 w-3 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500"></span>
            </span>
            <div>
              <div className="text-xs font-bold text-zinc-200">Painel de Controle • CRM Sofia Manager</div>
              <div className="text-[11px] text-zinc-400">Gestão centralizada de estoque, pré-vendas, IA e equipe no Umbará</div>
            </div>
          </div>

          <div className="flex items-center gap-3 text-xs font-semibold text-zinc-300">
            <div className="flex items-center gap-1.5 bg-zinc-950/70 px-3 py-1.5 rounded-xl border border-zinc-800/80 shadow-sm">
              <span className="text-zinc-500">Mensagens:</span>
              <span className="text-amber-400 font-bold">{estatisticas.totalMensagens}</span>
            </div>
            <div className="flex items-center gap-1.5 bg-zinc-950/70 px-3 py-1.5 rounded-xl border border-zinc-800/80 shadow-sm">
              <span className="text-zinc-500">Automação Sofía:</span>
              <span className="text-emerald-400 font-bold">{estatisticas.taxaAutomacao}%</span>
            </div>
            <div className="flex items-center gap-1.5 bg-zinc-950/70 px-3 py-1.5 rounded-xl border border-zinc-800/80 shadow-sm">
              <span className="text-zinc-500">Equipe:</span>
              <span className="text-zinc-200 font-bold">{usuarios.filter(u => u.ativo && u.funcao !== 'cliente').length} ativos</span>
            </div>
          </div>
        </div>
        
        {/* TAB 1: OPERADORES */}
        {activeTab === 'operadores' && (
          <div
            className="flex h-full min-w-0 flex-col space-y-6 overflow-y-auto pr-1"
            data-testid="user-management-flow"
          >
            <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-4 shrink-0">
              <div>
                <h2 className="text-2xl font-bold text-zinc-100 tracking-tight">Gestão de Usuários e Equipe</h2>
                <p className="text-sm text-zinc-400 mt-1">
                  Gerencie funções, permissões e status de acesso dos atendentes, supervisores e clientes.
                </p>
              </div>
              <div className="flex items-center gap-3 w-full sm:w-auto">
                <button
                  type="button"
                  onClick={() => {
                    setCreateUserError(null)
                    setCreateUserModal({
                      isOpen: true,
                      nome: '',
                      email: '',
                      senha: '',
                      funcao: 'vendedor',
                      telefone: '',
                    })
                  }}
                  className="flex items-center gap-1.5 px-4 py-2.5 bg-amber-500 hover:bg-amber-600 font-bold text-zinc-950 text-xs rounded-xl shadow-md shadow-amber-500/10 transition-all cursor-pointer shrink-0 active:scale-95"
                >
                  <UserPlus className="h-4 w-4" />
                  <span>Novo Membro</span>
                </button>
                <div className="relative w-full sm:w-64">
                  <Search className="absolute left-3.5 top-3 h-4 w-4 text-zinc-500" />
                  <input
                    type="text"
                    placeholder="Buscar por nome ou e-mail..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-10 pr-4 py-2.5 bg-zinc-900/40 border border-zinc-800 focus:border-amber-500/80 rounded-xl text-sm text-zinc-200 placeholder-zinc-500 outline-none transition-all"
                  />
                </div>
              </div>
            </div>

            {/* Filtros de Roles (Equipe / Clientes) */}
            <div className="flex items-center gap-2 border-b border-zinc-800/60 pb-4 shrink-0">
              <button
                type="button"
                onClick={() => setRoleFilter('staff')}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                  roleFilter === 'staff'
                    ? 'bg-amber-500 text-zinc-950 shadow-md shadow-amber-500/10 border border-transparent'
                    : 'bg-zinc-900/60 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 border border-zinc-800'
                }`}
              >
                Equipe (Admin, Supervisor, Atendente)
              </button>
              <button
                type="button"
                onClick={() => setRoleFilter('clients')}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                  roleFilter === 'clients'
                    ? 'bg-amber-500 text-zinc-950 shadow-md shadow-amber-500/10 border border-transparent'
                    : 'bg-zinc-900/60 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 border border-zinc-800'
                }`}
              >
                Clientes
              </button>
            </div>

            {/* Tabela de Operadores */}
            <div className="flex-1 overflow-y-auto border border-zinc-800 rounded-xl bg-zinc-900/10">
              {filteredUsuarios.length === 0 ? (
                <div className="flex h-64 flex-col items-center justify-center text-zinc-500">
                  <Users className="h-10 w-10 mb-2 stroke-zinc-700 animate-pulse" />
                  <p className="text-sm">
                    {roleFilter === 'clients' ? 'Nenhum cliente encontrado.' : 'Nenhum operador encontrado.'}
                  </p>
                </div>
              ) : (
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-zinc-800 bg-zinc-900/30 text-xs font-bold text-zinc-400 uppercase tracking-wider">
                      <th className="px-6 py-4">Nome</th>
                      <th className="px-6 py-4">E-mail / Telefone</th>
                      <th className="px-6 py-4">Função</th>
                      <th className="px-6 py-4 text-center">Status</th>
                      <th className="px-6 py-4 text-center">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60 text-sm">
                    {filteredUsuarios.map((user) => {
                      const isSelf = user.id === usuarioLogado.id
                      return (
                        <tr key={user.id} className="hover:bg-zinc-900/20 transition-colors">
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-2.5">
                              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-800 font-bold text-zinc-300">
                                {user.nome.charAt(0).toUpperCase()}
                              </div>
                              <div>
                                <div className="font-semibold text-zinc-200 flex items-center gap-1.5">
                                  {user.nome}
                                  {isSelf && (
                                    <span className="rounded bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 text-[9px] font-bold text-amber-500 uppercase tracking-wider">
                                      Você
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <div className="space-y-1">
                              {user.telefone ? (
                                <div className="text-amber-400 font-mono text-xs font-bold flex items-center gap-1.5">
                                  <Phone className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                                  <span>{user.telefone}</span>
                                </div>
                              ) : (
                                <span className="text-zinc-500 font-mono text-xs">Sem telefone</span>
                              )}
                              {user.email && (
                                <div className="text-zinc-400 font-mono text-[11px] flex items-center gap-1">
                                  <Mail className="h-3 w-3 text-zinc-500 shrink-0" />
                                  <span>{user.email}</span>
                                </div>
                              )}
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <select
                              value={user.funcao}
                              onChange={(e) => handleRoleChangeClick(user, e.target.value)}
                              disabled={isSelf}
                              className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 focus:border-amber-500 focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed capitalize cursor-pointer transition-colors"
                            >
                              <option value="admin">Administrador</option>
                              <option value="supervisor">Supervisor</option>
                              <option value="vendedor">Vendedor</option>
                              <option value="cliente">Cliente</option>
                            </select>
                          </td>
                          <td className="px-6 py-4 text-center">
                            <div className="flex justify-center">
                              <ToggleButton
                                checked={user.ativo}
                                onChange={() => handleToggleStatusClick(user)}
                                disabled={isSelf}
                              />
                            </div>
                          </td>
                          <td className="px-6 py-4 text-center">
                            <div className="flex items-center justify-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleEditUserClick(user)}
                                className="p-2 text-zinc-400 hover:text-amber-400 hover:bg-amber-500/10 rounded-lg transition-all cursor-pointer"
                                title="Editar dados cadastrais e redefinir senha"
                              >
                                <Edit3 className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteUserClick(user)}
                                disabled={isSelf}
                                className="p-2 text-rose-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg disabled:opacity-40 disabled:hover:bg-transparent transition-all cursor-pointer"
                                title="Excluir acesso e anonimizar dados pessoais"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => { setPurgeError(null); setPurgePassword(''); setPurgeConfirmation(''); setPurgeModal({ userId: user.id, userName: user.nome }) }}
                                disabled={isSelf}
                                className="rounded-lg border border-rose-500/40 px-2 py-1 text-[10px] font-bold text-rose-300 hover:bg-rose-500/10 disabled:opacity-40"
                                title="Purga total de conta de teste"
                              >
                                Purga total
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <section
              className="min-w-0 shrink-0 overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-900/30"
              data-testid="anonymized-records-panel"
            >
              <button
                type="button"
                aria-expanded={residualsExpanded}
                aria-controls="anonymized-records-content"
                onClick={() => setResidualsExpanded((expanded) => !expanded)}
                className="flex w-full min-w-0 items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-zinc-900/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500"
              >
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-bold text-zinc-200">Registros anonimizados preservados</span>
                    <span className="rounded-full border border-zinc-700 bg-zinc-950/70 px-2 py-0.5 text-[10px] font-bold text-zinc-400">
                      {residuals.length}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-xs text-zinc-500">
                    Retenção normal sem identidade ou conta Auth.
                  </span>
                </span>
                <ChevronRight
                  aria-hidden="true"
                  className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform ${residualsExpanded ? 'rotate-90' : ''}`}
                />
              </button>

              {residualsExpanded && (
                <div className="border-t border-zinc-800/80 p-3 sm:p-4" id="anonymized-records-content">
                  <p className="mb-3 text-xs text-zinc-400">
                    Estes registros são preservados pela política de retenção e não devem ser tratados automaticamente como contas de teste.
                  </p>
                  <div className="space-y-2">
                    {residuals.map((row) => (
                      <article
                        className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3"
                        key={row.id}
                      >
                        <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                          <div className="min-w-0 space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <code className="break-all text-[11px] text-zinc-300">{row.id}</code>
                              <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-300">
                                Retido
                              </span>
                            </div>
                            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-400">
                              <span>Conversas {row.conversations}</span>
                              <span>Mensagens {row.messages}</span>
                              <span>Pedidos {row.orders}</span>
                              <span>Provas {row.paymentProofs}</span>
                              <span>Comprovantes {row.legacyReceipts}</span>
                            </div>
                          </div>
                          <button
                            className="w-full shrink-0 rounded-lg border border-rose-500/40 px-3 py-2 text-xs font-bold text-rose-300 transition-colors hover:bg-rose-500/10 sm:w-auto"
                            onClick={() => { setResidualModal(row.id); setPurgeError(null) }}
                          >
                            Purgar registro anonimizado de teste
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              )}
            </section>
          </div>
        )}

        {residualModal && <div className="fixed inset-0 z-[70] grid place-items-center bg-black/80 p-4"><div className="w-full max-w-md rounded-xl bg-zinc-900 p-5"><h3 className="font-bold text-rose-300">Purgar registro anonimizado de teste</h3><p className="mt-2 text-xs text-zinc-300">Somente para limpeza excepcional de um registro já anonimizado por engano/teste. Não há conta Auth associada.</p><code className="mt-2 block text-xs">{residualModal}</code><input aria-label="Senha atual do administrador para residual" autoComplete="current-password" className="mt-3 w-full rounded bg-zinc-950 p-2" onChange={(e) => setResidualPassword(e.target.value)} type="password" value={residualPassword}/><input aria-label="Confirmação de purga residual" className="mt-2 w-full rounded bg-zinc-950 p-2" onChange={(e) => setResidualConfirmation(e.target.value)} placeholder="PURGAR RESIDUAL DEFINITIVAMENTE" value={residualConfirmation}/>{purgeError && <p className="mt-2 text-xs text-rose-300">{purgeError}</p>}<div className="mt-3 flex justify-end gap-2"><button onClick={() => setResidualModal(null)}>Cancelar</button><button disabled={!residualPassword || residualConfirmation !== 'PURGAR RESIDUAL DEFINITIVAMENTE'} onClick={purgeResidual}>Confirmar purga residual</button></div></div></div>}

        {/* TAB: PERFIL DA EMPRESA */}
        {activeTab === 'empresa' && (
          <BusinessProfileCard
            initialConfigs={systemConfigs}
            showToast={showToast}
          />
        )}

        {/* TAB 2: INTEGRAÇÕES */}
        {activeTab === 'integracoes' && (
          <div className="flex flex-col h-full space-y-6 overflow-y-auto pr-6 pb-10">
            <div>
              <h2 className="text-2xl font-bold text-zinc-100 tracking-tight">Integrações do Sistema</h2>
              <p className="text-sm text-zinc-400 mt-1">
                Configure cada serviço em uma posição fixa. As opções permanecem organizadas e não podem ser reordenadas.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 items-start" aria-label="Opções de integração">
              <article aria-label="WhatsApp" className="lg:col-span-2">
                <WhatsAppCard
                  initialConfigs={systemConfigs}
                  showToast={showToast}
                  provedorAtivo={provedorAtivo}
                  onProvedorChange={setProvedorAtivo}
                />
              </article>
              <article aria-label="LLM API" className="lg:col-span-2">
                <LlmApiCard initialConfigs={systemConfigs} showToast={showToast} />
              </article>
              <article aria-label="Telegram"><TelegramBotCard initialConfigs={systemConfigs} showToast={showToast} /></article>
              <article aria-label="Mercado Pago"><MercadoPagoCard initialConfigs={systemConfigs} showToast={showToast} /></article>
            </div>
          </div>
        )}

        {/* TAB: BASE DE CONHECIMENTO */}
        {activeTab === 'conhecimento' && (
          <div className="flex flex-col h-full w-full overflow-hidden -m-8 flex-1">
            <KnowledgeCRUD artigosIniciais={artigosIniciais} perfilFuncao={usuarioLogado.funcao} />
          </div>
        )}

        {/* TAB 3: MÉTRICAS */}
        {activeTab === 'metricas' && (
          <div className="flex flex-col h-full space-y-6 overflow-y-auto">
            <div className="flex justify-between items-center shrink-0">
              <div>
                <h2 className="text-2xl font-bold text-zinc-100 tracking-tight">Métricas & Indicadores</h2>
                <p className="text-sm text-zinc-400 mt-1">
                  Visualize a proporção de mensagens geradas e o nível de automação do atendimento.
                </p>
              </div>
              <button
                onClick={handleRefreshMetrics}
                disabled={refreshingMetrics}
                className="flex items-center gap-1.5 px-3.5 py-2 border border-zinc-800 bg-zinc-900/50 text-zinc-300 hover:text-zinc-100 rounded-xl text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${refreshingMetrics ? 'animate-spin' : ''}`} />
                Atualizar Indicadores
              </button>
            </div>

            <section aria-label="Auditoria operacional financeira" className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-5 space-y-4">
              <div>
                <h3 className="font-bold text-lg text-zinc-200">Controle operacional financeiro</h3>
                <p className="text-xs text-zinc-400 mt-1">Auditoria agregada do período de 30 dias. Isto é controle operacional, não é contabilidade fiscal nem escrituração de partidas dobradas.</p>
                <p className="text-xs text-zinc-500 mt-1">Pagamentos parciais e combinados permanecem desabilitados. Margem operacional: Não disponível — não há dados autoritativos de produto/COGS; taxas de provedor não representam todos os custos.</p>
                {financialMetricsFetchedAt && <p className="text-[10px] text-zinc-500 mt-2">Proveniência: RPCs operacionais agregadas · Atualizado em {new Date(financialMetricsFetchedAt).toLocaleString('pt-BR')} · [{financialMetrics?.period.startAt} — {financialMetrics?.period.endAt})</p>}
              </div>
              {financialMetricsError ? <p role="alert" className="text-sm text-rose-400">{financialMetricsError}</p> : financialMetrics && <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
                {[
                  ['Pedidos criados / vendas aprovadas', `${financialMetrics.ordersCreated} pedidos · ${financialMetrics.approvedSalesCount} vendas aprovadas`],
                  ['Receita bruta aprovada', `R$ ${(financialMetrics.grossApprovedCents / 100).toFixed(2)}`],
                  ['Reembolsos / Receita operacional líquida', `R$ ${(financialMetrics.refundsCents / 100).toFixed(2)} / R$ ${(financialMetrics.netOperationalRevenueCents / 100).toFixed(2)}`],
                  ['Ticket médio aprovado', financialMetrics.averageApprovedTicketCents === null ? 'Não disponível: sem vendas aprovadas válidas' : `R$ ${(financialMetrics.averageApprovedTicketCents / 100).toFixed(2)}`],
                  ['Provedor: bruto / taxas / líquido', `R$ ${(financialMetrics.providerGrossCents / 100).toFixed(2)} / R$ ${(financialMetrics.providerFeesCents / 100).toFixed(2)} / R$ ${(financialMetrics.providerNetCents / 100).toFixed(2)}`],
                  ['Contas a receber em aberto', `${financialMetrics.openReceivablesCount} · R$ ${(financialMetrics.openReceivablesCents / 100).toFixed(2)}`],
                  ['Caixa: sessões / diferença', `${financialMetrics.cashSessionsOpened} abertas · ${financialMetrics.cashSessionsClosed} fechadas · R$ ${(financialMetrics.cashDifferenceCents / 100).toFixed(2)}`],
                  ['Conciliação bancária', `${financialMetrics.bankReconciledCount} conciliadas (R$ ${(financialMetrics.bankReconciledCents / 100).toFixed(2)}) · ${financialMetrics.bankUnreconciledCount} pendentes (R$ ${(financialMetrics.bankUnreconciledCents / 100).toFixed(2)})`],
                ].map(([label, value]) => <div key={label} className="rounded-xl border border-zinc-800 p-3"><p className="text-zinc-500">{label}</p><p className="text-zinc-200 font-semibold mt-1">{value}</p></div>)}
              </div>}
            </section>

            {/* Grid de Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-5 space-y-1.5 shadow-md">
                <span className="text-zinc-500 text-[10px] font-bold uppercase tracking-wider">Total de Mensagens</span>
                <div className="text-2xl font-black text-zinc-100">{estatisticas.totalMensagens}</div>
                <div className="text-[10px] text-zinc-500">Volume trafegado no sistema</div>
              </div>
              
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-5 space-y-1.5 shadow-md">
                <span className="text-zinc-500 text-[10px] font-bold uppercase tracking-wider">Mensagens de Clientes</span>
                <div className="text-2xl font-black text-zinc-100">{estatisticas.totalCliente}</div>
                <div className="text-[10px] text-zinc-500">Inbound e perguntas recebidas</div>
              </div>

              <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-5 space-y-1.5 shadow-md">
                <span className="text-zinc-500 text-[10px] font-bold uppercase tracking-wider">Respostas Humanas</span>
                <div className="text-2xl font-black text-zinc-100">{estatisticas.totalOperador}</div>
                <div className="text-[10px] text-zinc-500">Enviadas pelos operadores</div>
              </div>

              <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-5 space-y-1.5 shadow-md">
                <span className="text-zinc-500 text-[10px] font-bold uppercase tracking-wider">Respostas de IA (Sofia)</span>
                <div className="text-2xl font-black text-zinc-100">{estatisticas.totalIa}</div>
                <div className="text-[10px] text-zinc-500">Respostas automáticas disparadas</div>
              </div>
            </div>

            {/* Circular Chart & Automation details */}
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-6 flex flex-col md:flex-row items-center gap-8">
              
              {/* Circular SVG Chart */}
              <div className="relative flex items-center justify-center shrink-0">
                {(() => {
                  const radius = 50
                  const circumference = 2 * Math.PI * radius
                  const offset = circumference - (estatisticas.taxaAutomacao / 100) * circumference
                  return (
                    <>
                      <svg className="h-32 w-32 transform -rotate-90">
                        <circle
                          cx="64"
                          cy="64"
                          r={radius}
                          className="stroke-zinc-800"
                          strokeWidth="10"
                          fill="transparent"
                        />
                        <circle
                          cx="64"
                          cy="64"
                          r={radius}
                          className="stroke-amber-500 transition-all duration-700 ease-out"
                          strokeWidth="10"
                          fill="transparent"
                          strokeDasharray={circumference}
                          strokeDashoffset={offset}
                          strokeLinecap="round"
                        />
                      </svg>
                      <div className="absolute flex flex-col items-center justify-center">
                        <span className="text-2xl font-black text-zinc-100">{estatisticas.taxaAutomacao}%</span>
                        <span className="text-[9px] uppercase tracking-wider font-bold text-zinc-500">Taxa IA</span>
                      </div>
                    </>
                  )
                })()}
              </div>

              {/* Descrição e Barra Proporcional */}
              <div className="flex-1 space-y-4 w-full">
                <div>
                  <h3 className="font-bold text-lg text-zinc-200">Taxa de Automação de Conversas</h3>
                  <p className="text-xs text-zinc-400 mt-1">
                    Esta taxa representa a proporção de mensagens enviadas pela IA Sofía em relação ao total de respostas fornecidas aos clientes (IA + Operadores Humanos).
                  </p>
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs font-bold">
                    <span className="text-amber-500">IA ({estatisticas.totalIa} msgs)</span>
                    <span className="text-zinc-500">Operadores ({estatisticas.totalOperador} msgs)</span>
                  </div>
                  <div className="h-3 w-full bg-zinc-800 rounded-full overflow-hidden flex">
                    <div
                      style={{ width: `${estatisticas.taxaAutomacao}%` }}
                      className="bg-amber-500 h-full transition-all duration-700"
                    />
                    <div
                      style={{ width: `${100 - estatisticas.taxaAutomacao}%` }}
                      className="bg-zinc-700 h-full transition-all duration-700"
                    />
                  </div>
                </div>

                <div className="flex gap-4 text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="h-3.5 w-3.5 rounded bg-amber-500 inline-block" />
                    <span className="text-zinc-400">Automação (IA)</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="h-3.5 w-3.5 rounded bg-zinc-700 inline-block" />
                    <span className="text-zinc-400">Intervenção Humana</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: AUDITORIA */}
        {activeTab === 'auditoria' && (
          <div className="flex flex-col h-full overflow-hidden space-y-6">
            <div className="flex justify-between items-center shrink-0">
              <div>
                <h2 className="text-2xl font-bold text-zinc-100 tracking-tight">Logs de Auditoria</h2>
                <p className="text-sm text-zinc-400 mt-1">
                  Listagem imutável de logs de segurança e ações executadas pela administração.
                </p>
              </div>
              <button
                onClick={handleRefreshLogs}
                disabled={refreshingLogs}
                className="flex items-center gap-1.5 px-3.5 py-2 border border-zinc-800 bg-zinc-900/50 text-zinc-300 hover:text-zinc-100 rounded-xl text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${refreshingLogs ? 'animate-spin' : ''}`} />
                Atualizar Logs
              </button>
            </div>

            {/* Filtros e Busca de Logs */}
            <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-4 shrink-0 border-b border-zinc-800/60 pb-4">
              {/* Filtros de Classificação */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setLogLevelFilter('all')
                    setCurrentPage(1)
                  }}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer border ${
                    logLevelFilter === 'all'
                      ? 'bg-zinc-100 text-zinc-950 border-zinc-200 font-bold'
                      : 'bg-zinc-900/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                  }`}
                >
                  Todos
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setLogLevelFilter('info')
                    setCurrentPage(1)
                  }}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer border flex items-center gap-1.5 ${
                    logLevelFilter === 'info'
                      ? 'bg-blue-600 text-white border-blue-500 shadow-md shadow-blue-950/20'
                      : 'bg-zinc-900/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                  }`}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-blue-400"></span>
                  Info
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setLogLevelFilter('warning')
                    setCurrentPage(1)
                  }}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer border flex items-center gap-1.5 ${
                    logLevelFilter === 'warning'
                      ? 'bg-amber-600 text-white border-amber-500 shadow-md shadow-amber-950/20'
                      : 'bg-zinc-900/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                  }`}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400"></span>
                  Alerta
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setLogLevelFilter('error')
                    setCurrentPage(1)
                  }}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer border flex items-center gap-1.5 ${
                    logLevelFilter === 'error'
                      ? 'bg-rose-600 text-white border-rose-500 shadow-md shadow-rose-950/20'
                      : 'bg-zinc-900/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                  }`}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-rose-400"></span>
                  Erro
                </button>
              </div>

              {/* Busca por Operador ou Ação */}
              <div className="relative w-full sm:w-72">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
                <input
                  type="text"
                  placeholder="Buscar operador ou ação..."
                  value={logSearchQuery}
                  onChange={(e) => {
                    setLogSearchQuery(e.target.value)
                    setCurrentPage(1)
                  }}
                  className="w-full pl-9 pr-4 py-2 bg-zinc-900/40 border border-zinc-800 focus:border-amber-500/80 rounded-xl text-xs text-zinc-200 placeholder-zinc-500 outline-none transition-all"
                />
              </div>
            </div>

            {/* Tabela de logs */}
            <div className="flex-1 overflow-y-auto border border-zinc-800 rounded-xl bg-zinc-900/10">
              {paginatedLogs.length === 0 ? (
                <div className="flex h-64 flex-col items-center justify-center text-zinc-500">
                  <Activity className="h-10 w-10 mb-2 stroke-zinc-700 animate-pulse" />
                  <p className="text-sm">Nenhum log de auditoria disponível.</p>
                </div>
              ) : (
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-zinc-800 bg-zinc-900/30 text-xs font-bold text-zinc-400 uppercase tracking-wider">
                      <th className="px-6 py-4">Nível</th>
                      <th className="px-6 py-4">Operador</th>
                      <th className="px-6 py-4">Ação</th>
                      <th className="px-6 py-4">Data / Hora</th>
                      <th className="px-6 py-4 text-right">Detalhes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60 text-sm">
                    {paginatedLogs.map((log) => {
                      // Lookup do operador no state de usuários
                      const op = usuarios.find(u => u.id === log.usuario_id)
                      const isExpanded = expandedLogId === log.id
                      const level = getLogLevel(log.acao, log.detalhes)
                      
                      let levelBadge = null
                      if (level === 'error') {
                        levelBadge = (
                          <span className="inline-flex items-center gap-1 rounded bg-rose-500/10 border border-rose-500/20 px-1.5 py-0.5 text-[10px] font-bold text-rose-400 uppercase">
                            Erro
                          </span>
                        )
                      } else if (level === 'warning') {
                        levelBadge = (
                          <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-400 uppercase">
                            Alerta
                          </span>
                        )
                      } else {
                        levelBadge = (
                          <span className="inline-flex items-center gap-1 rounded bg-blue-500/10 border border-blue-500/20 px-1.5 py-0.5 text-[10px] font-bold text-blue-400 uppercase">
                            Info
                          </span>
                        )
                      }

                      return (
                        <React.Fragment key={log.id}>
                          <tr className="hover:bg-zinc-900/10 transition-colors">
                            <td className="px-6 py-4">
                              {levelBadge}
                            </td>
                            <td className="px-6 py-4 font-semibold text-zinc-200">
                              {op ? op.nome : 'Sistema / Anon'}
                            </td>
                            <td className="px-6 py-4 text-zinc-300">
                              {formatActionName(log.acao)}
                            </td>
                            <td className="px-6 py-4 text-zinc-400 text-xs font-mono">
                              {new Date(log.data_criacao).toLocaleString('pt-BR')}
                            </td>
                            <td className="px-6 py-4 text-right">
                              <button
                                onClick={() => setExpandedLogId(isExpanded ? null : log.id)}
                                className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all cursor-pointer ${
                                  isExpanded
                                    ? 'bg-amber-500 border-amber-500 text-zinc-950 font-bold'
                                    : 'border-zinc-800 hover:border-zinc-700 bg-zinc-900/40 text-zinc-300 hover:text-zinc-100'
                                }`}
                              >
                                <Eye className="h-3 w-3" />
                                {isExpanded ? 'Ocultar' : 'Visualizar'}
                              </button>
                            </td>
                          </tr>

                          {/* Área Expansível */}
                          {isExpanded && (
                            <tr>
                              <td colSpan={5} className="bg-zinc-950 px-6 py-5 border-b border-zinc-800 text-xs">
                                <div className="flex justify-between items-center mb-3">
                                  <span className="font-bold text-zinc-400 flex items-center gap-1.5">
                                    <ShieldCheck className="h-4 w-4 text-amber-500" />
                                    Payload Completo do Log (JSON)
                                  </span>
                                  <button
                                    onClick={() => {
                                      navigator.clipboard.writeText(JSON.stringify(log.detalhes, null, 2))
                                      showToast('success', 'JSON copiado para área de transferência.')
                                    }}
                                    className="text-amber-500 hover:text-amber-400 text-[10px] uppercase font-black tracking-wider cursor-pointer"
                                  >
                                    Copiar Payload
                                  </button>
                                </div>
                                <pre className="text-amber-500/90 font-mono p-4 bg-zinc-900/40 rounded-xl border border-zinc-850 overflow-x-auto leading-relaxed shadow-inner">
                                  {JSON.stringify(log.detalhes, null, 2)}
                                </pre>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Paginação */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-2 shrink-0 pt-2">
                <span className="text-xs text-zinc-500 font-semibold">
                  Página {currentPage} de {totalPages}
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                    disabled={currentPage === 1}
                    className="flex h-9 items-center justify-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 text-xs font-semibold text-zinc-300 hover:text-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    Anterior
                  </button>
                  <button
                    onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                    disabled={currentPage === totalPages}
                    className="flex h-9 items-center justify-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 text-xs font-semibold text-zinc-300 hover:text-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
                  >
                    Próximo
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 5: PROMPT */}
        {activeTab === 'prompt' && (
          <div className="flex flex-col h-full space-y-6 overflow-hidden max-w-4xl">
            <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-4 shrink-0">
              <div>
                <h2 className="text-2xl font-bold text-zinc-100 tracking-tight">Master System Prompt</h2>
                <p className="text-sm text-zinc-400 mt-1">
                  Gerencie as instruções de persona e as diretrizes operacionais em tempo real da Sofía.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={handleCopyPrompt}
                  className="flex items-center justify-center gap-2 px-4.5 py-2.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-zinc-100 border border-zinc-800 font-semibold text-xs shadow-md transition-all cursor-pointer active:scale-95"
                >
                  {copiedPrompt ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                      Copiado!
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      Copiar Prompt
                    </>
                  )}
                </button>
                <button
                  onClick={handleSavePrompt}
                  disabled={savingPrompt}
                  className="flex items-center justify-center gap-2 px-4.5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-zinc-950 font-bold text-xs shadow-md transition-all cursor-pointer active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {savingPrompt ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Salvando...
                    </>
                  ) : (
                    'Salvar Prompt'
                  )}
                </button>
              </div>
            </div>

            {/* Textarea editável */}
            <div className="flex-1 min-h-[300px] border border-zinc-800 bg-zinc-900/20 rounded-2xl p-5 overflow-hidden flex flex-col">
              <textarea
                value={promptValue}
                onChange={(e) => setPromptValue(e.target.value)}
                className="w-full flex-1 bg-transparent text-zinc-300 font-mono text-xs leading-relaxed focus:outline-none resize-none overflow-y-auto"
                style={{ scrollbarWidth: 'thin' }}
              />
            </div>
            
            <div className="rounded-xl border border-amber-500/10 bg-amber-500/5 p-4 text-xs text-amber-500/80 leading-relaxed shrink-0 flex gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500 mt-0.5" />
              <div>
                Este prompt é carregado pelo pipeline de IA da DeepSeek para estruturar as respostas. Ele foi desenhado para assegurar o tom curitibano de atendimento, evitar alucinações técnicas fora da base de conhecimento e garantir o encaminhamento suave ao transbordo humano sempre que necessário.
              </div>
            </div>
          </div>
        )}

        {/* TAB: HORÁRIOS */}
        {activeTab === 'horarios' && (
          <div className="flex flex-col h-full overflow-hidden">
            <BusinessHoursManager />
          </div>
        )}

        {/* TAB: ESTOQUE */}
        {activeTab === 'estoque' && (
          <div className="flex flex-col h-full overflow-hidden">
            <InventoryManager perfilFuncao={usuarioLogado.funcao} perfilAtivo={usuarioLogado.ativo} />
          </div>
        )}

        {activeTab === 'storage-orphans' && (
          <div className="flex flex-col h-full overflow-y-auto space-y-4 pr-2">
            <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-4 pb-2 border-b border-zinc-800/60 shrink-0">
              <div>
                <h2 className="text-2xl font-bold text-zinc-100 tracking-tight">Reconciliação de Imagens Órfãs</h2>
                <p className="text-sm text-zinc-400 mt-1">
                  Gerencie e libere arquivos no bucket sem vínculo com o cardápio ou comprovantes.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={carregarReconciliacoesImagemOrfa}
                  disabled={carregandoStorageReconciliations}
                  className="flex items-center gap-1.5 px-3 py-2 border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-800 text-zinc-300 hover:text-zinc-100 rounded-xl text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${carregandoStorageReconciliations ? 'animate-spin' : ''}`} />
                  <span>Atualizar</span>
                </button>
                <button
                  type="button"
                  onClick={handleExecutarVarredura}
                  disabled={escaneandoStorage}
                  className="flex items-center gap-1.5 px-3.5 py-2 bg-amber-500 hover:bg-amber-400 active:scale-95 text-zinc-950 rounded-xl text-xs font-bold transition-all shadow-md cursor-pointer disabled:opacity-50"
                >
                  {escaneandoStorage ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Escaneando...</span>
                    </>
                  ) : (
                    <>
                      <Search className="h-3.5 w-3.5" />
                      <span>Escanear Imagens (Varredura)</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {!storageReconciliationsLoaded || carregandoStorageReconciliations ? (
              <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/10 text-zinc-500">
                <Loader2 className="h-8 w-8 animate-spin text-amber-500 mb-2" />
                <p className="text-sm">Carregando reconciliações de imagens...</p>
              </div>
            ) : (
              <>
                {storageReconciliationError ? (
                  <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-4 text-xs font-medium text-rose-300" role="alert">
                    {storageReconciliationError}
                  </div>
                ) : null}
                <StorageOrphanReconciliationPanel
                  approveReconciliation={aprovarReconciliacaoImagemOrfa}
                  executeReconciliation={executarReconciliacaoImagemOrfa}
                  initialReconciliations={storageReconciliations}
                />
              </>
            )}
          </div>
        )}

        {/* TAB: COMPROVANTES */}
        {activeTab === 'comprovantes' && <PaymentProofAdminPanel role={usuarioLogado.funcao} />}
        {false && activeTab === 'comprovantes' && (
          <div className="flex flex-col h-full overflow-hidden space-y-6">
            <div className="flex justify-between items-center shrink-0">
              <div>
                <h2 className="text-2xl font-bold text-zinc-100 tracking-tight">Comprovantes de Pagamento</h2>
                <p className="text-sm text-zinc-400 mt-1">
                  Visualize e revise os comprovantes de pagamento em PDF enviados pelos clientes.
                </p>
              </div>
              <button
                onClick={carregarDadosComprovantes}
                disabled={carregandoComprovantes}
                className="flex items-center gap-1.5 px-3.5 py-2 border border-zinc-800 bg-zinc-900/50 text-zinc-300 hover:text-zinc-100 rounded-xl text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${carregandoComprovantes ? 'animate-spin' : ''}`} />
                Atualizar
              </button>
            </div>

            {/* Filtros */}
            <div className="flex flex-col sm:flex-row gap-4 shrink-0 border-b border-zinc-800/60 pb-4">
              <div className="relative flex-1">
                <Search className="absolute left-3.5 top-3.5 h-4 w-4 text-zinc-500" />
                <input
                  type="text"
                  placeholder="Filtrar por nome do cliente..."
                  value={filtroClienteNome}
                  onChange={(e) => setFiltroClienteNome(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 bg-zinc-900/40 border border-zinc-800 focus:border-amber-500/80 rounded-xl text-sm text-zinc-200 placeholder-zinc-500 outline-none transition-all"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-500 font-semibold">De:</span>
                <input
                  type="date"
                  value={filtroDataInicio}
                  onChange={(e) => setFiltroDataInicio(e.target.value)}
                  className="bg-zinc-900/40 border border-zinc-800 rounded-xl px-3 py-2.5 text-xs text-zinc-200 outline-none focus:border-amber-500/80"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-500 font-semibold">Até:</span>
                <input
                  type="date"
                  value={filtroDataFim}
                  onChange={(e) => setFiltroDataFim(e.target.value)}
                  className="bg-zinc-900/40 border border-zinc-800 rounded-xl px-3 py-2.5 text-xs text-zinc-200 outline-none focus:border-amber-500/80"
                />
              </div>
            </div>

            {/* Tabela de Comprovantes */}
            <div className="flex-1 overflow-y-auto border border-zinc-800 rounded-xl bg-zinc-900/10">
              {carregandoComprovantes ? (
                <div className="flex h-64 flex-col items-center justify-center text-zinc-500">
                  <Loader2 className="h-8 w-8 animate-spin text-amber-500 mb-2" />
                  <p className="text-sm">Carregando comprovantes...</p>
                </div>
              ) : comprovantesFiltrados.length === 0 ? (
                <div className="flex h-64 flex-col items-center justify-center text-zinc-500">
                  <FileText className="h-10 w-10 mb-2 stroke-zinc-700" />
                  <p className="text-sm">Nenhum comprovante encontrado.</p>
                </div>
              ) : (
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-zinc-800 bg-zinc-900/30 text-xs font-bold text-zinc-400 uppercase tracking-wider">
                      <th className="px-6 py-4">Cliente</th>
                      <th className="px-6 py-4">Arquivo</th>
                      <th className="px-6 py-4">Tamanho</th>
                      <th className="px-6 py-4">Data de Envio</th>
                      <th className="px-6 py-4 text-right">Ação</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60 text-sm">
                    {comprovantesFiltrados.map((comp) => {
                      const tamanhoKB = (comp.tamanho_bytes / 1024).toFixed(1)
                      const dataFormatada = new Date(comp.data_criacao).toLocaleString('pt-BR')
                      return (
                        <tr key={comp.id} className="hover:bg-zinc-900/10 transition-colors">
                          <td className="px-6 py-4 font-semibold text-zinc-200">
                            {comp.clientes?.nome || 'Cliente Desconhecido'}
                          </td>
                          <td className="px-6 py-4 text-zinc-300 font-mono text-xs">
                            {comp.nome_arquivo}
                          </td>
                          <td className="px-6 py-4 text-zinc-400">
                            {tamanhoKB} KB
                          </td>
                          <td className="px-6 py-4 text-zinc-400 text-xs font-mono">
                            {dataFormatada}
                          </td>
                          <td className="px-6 py-4 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => handleSelectComprovante(comp)}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-zinc-800 hover:border-amber-500/50 bg-zinc-900/60 hover:bg-zinc-800 text-zinc-200 hover:text-amber-400 text-xs font-bold transition-all shadow-sm active:scale-95 cursor-pointer"
                                title="Visualizar comprovante no aplicativo"
                              >
                                <Eye className="h-3.5 w-3.5" />
                                Visualizar
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDownloadComprovante(comp)}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-zinc-800 hover:border-amber-500/50 bg-zinc-900/60 hover:bg-zinc-800 text-zinc-300 hover:text-amber-400 text-xs font-bold transition-all shadow-sm active:scale-95 cursor-pointer"
                                title="Baixar arquivo do comprovante"
                              >
                                <Download className="h-3.5 w-3.5" />
                                Baixar
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Modal de Visualização de Comprovante Integrado */}
            <ModalVisualizadorComprovante
              isOpen={!!selectedComprovante}
              onClose={() => setSelectedComprovante(null)}
              urlArquivo={selectedComprovante?.url_arquivo || null}
              nomeArquivo={selectedComprovante?.nome_arquivo}
              tamanhoBytes={selectedComprovante?.tamanho_bytes}
              clienteNome={selectedComprovante?.clientes?.nome}
              dataCriacao={selectedComprovante?.data_criacao}
            />
          </div>
        )}

      </section>
    </div>
  )
}

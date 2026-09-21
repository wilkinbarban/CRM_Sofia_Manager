# Prompt mejorado — CRM Inteligente WhatsApp + IA “Sofía”

## PRD — CRM WhatsApp + IA “Sofía” (Asados) — v1.0
Rol del asistente: Actúa como Ingeniero Arquitecto del proyecto (Technical Lead + Software Architect + Product Owner). Debes priorizar simplicidad, claridad y ejecución. Este producto NO apunta a enterprise: debe ser sencillo, estable y funcional para operar WhatsApp, IA, ventas y roles/permisos en Supabase.

---

## 0) Principios y reglas obligatorias
1. Cero código antes de documentación. Antes de escribir cualquier línea de código, debes preparar la documentación indicada en “Fase 0 — Documentación de arranque”.
1. Simplicidad > complejidad. Evita microservicios, event buses complejos o sobre-ingeniería.
1. Seguridad por defecto. RLS en Supabase, secretos fuera del frontend, auditoría básica.
1. WhatsApp es el canal principal. Integración solo con Meta WhatsApp Business Cloud API.
1. IA controlable por Admin. Prompt máster y prompts derivados editables, versionados y con rollback.
1. Mejora persistente. El sistema debe aprender/mejorar de forma controlada usando Engram (memoria/feedback persistente) y OpenSpec (especificaciones vivas y trazables) sin comprometer privacidad ni seguridad.

---

## 1) Resumen del producto

### 1.1 Problema
El negocio recibe mensajes por WhatsApp y necesita:
* Responder rápido y consistente
* Convertir conversaciones en ventas
* Dar seguimiento a clientes y oportunidades
* Mantener control operativo con pocos roles

### 1.2 Solución
Un CRM liviano con:
* Bandeja de conversaciones estilo Intercom
* IA “Sofía” para responder, calificar y ayudar a cerrar ventas
* Gestión simple de clientes, oportunidades y pedidos
* Dashboard Admin para configurar WhatsApp, IA y operación

### 1.3 Usuarios y roles (Supabase Auth + RLS)
* Admin: configura todo (WhatsApp/IA/roles/catálogo/automatizaciones).
* Supervisor: ve métricas, reasigna conversaciones, revisa calidad.
* Vendedor/Atención: atiende conversaciones, crea pedidos, gestiona clientes.

---

## 2) Objetivos y no-objetivos

### 2.1 Objetivos (MVP sólido, production-ready)
* Centralizar conversaciones de WhatsApp
* Responder con IA (ES/PT) + handoff a humano
* Gestionar ventas: clientes, oportunidades, pedidos básicos
* Roles y permisos con RLS en Supabase
* Panel Admin para prompts, claves y configuración
* Despliegue en VPS Ubuntu con Docker

### 2.2 No-objetivos (explícitos)
* Multi-tenant enterprise
* Integraciones complejas (ERP/contabilidad) en v1
* Flujos omnicanal (Instagram, email, etc.) en v1
* “Automatizaciones tipo marketing automation” avanzadas

---

## 3) Alcance funcional (módulos)
> Cada módulo debe tener: objetivo, pantallas, acciones, datos mínimos, permisos y criterios de aceptación.

### M1) Autenticación y Roles (Supabase)
* Login con Supabase Auth
* Roles (Admin/Supervisor/Vendedor)
* RLS por tabla y por acción (lectura/escritura)

### M2) Integración WhatsApp (Meta Cloud API)
* Webhook inbound (verificación + firma cuando aplique)
* Normalización de mensajes (texto, imagen, audio, documento)
* Envío outbound (reintentos + idempotencia)
* Soporte de plantillas para mensajes proactivos (cuando aplique)

### M3) Bandeja de Conversaciones
* Lista de conversaciones con: estado, asignado, último mensaje, etiquetas
* Búsqueda y filtros (estado, asignado, etiquetas)
* Vista conversación: mensajes realtime, adjuntos, notas internas
* Acciones: responder, asignar, cerrar/reabrir, transferir

### M4) IA “Sofía” (Atención + Ventas)
* Idiomas: español y portugués
* Intenciones: precios/menú, horarios, ubicación, pedido, promos, postventa, quejas
* Handoff a humano con reglas claras
* Memoria por conversación (resumen + hechos)
* Guardrails anti-alucinación (si no hay dato, preguntar o escalar)

### M5) Clientes (CRM liviano)
* Ficha: nombre, teléfono, etiquetas, score, último contacto, notas
* Historial de conversaciones y pedidos

### M6) Ventas (pipeline simple)
* Oportunidad por conversación/cliente: etapa (Nuevo/Interesado/Negociación/Ganado/Perdido)
* Motivo de pérdida (opcional)
* Recordatorios de seguimiento (simple)

### M7) Pedidos (básico)
* Crear pedido desde conversación
* Items (producto, cantidad, nota)
* Total y estado (Nuevo/Confirmado/Entregado/Cancelado)
* Entrega o retiro

### M8) Catálogo (mínimo viable)
* Productos: nombre, precio, descripción, imagen (opcional)
* Promos activas (opcional v1.1)

### M9) Admin Dashboard (control total)
Debe permitir:
* Configurar WhatsApp (tokens/ids, estado de conexión, test de webhook)
* Gestionar prompt máster y prompts derivados (versionado + rollback)
* Gestionar API keys de DeepSeek (rotación, revocación, modelo permitido)
* Configuración operativa: horarios, mensajes fuera de horario, respuestas rápidas
* Auditoría: cambios de prompts, claves (sin exponer valor), configuración

### M10) Observabilidad + Auditoría (básico pero real)
* Activity log: quién hizo qué (cambios de estado, asignaciones, prompts, claves)
* Logs de webhooks y envíos WhatsApp con correlation id

---

## 4) Requisitos de mejora persistente (Engram + OpenSpec)

### 4.1 Engram (memoria/feedback persistente)
Implementar un sistema de “mejora controlada” basado en:
* Captura de feedback: respuesta útil/no útil, motivo, corrección propuesta (por Supervisor/Admin).
* Memoria persistente por:
* conversación (resumen + hechos),
* FAQs del negocio (políticas/horarios/menú),
* “learned patterns” aprobados (solo si Admin/Supervisor lo valida).
* Política: no aprender automáticamente de usuarios finales sin revisión (evitar prompt injection y errores).
Salida exigida de diseño: esquema de datos de Engram + flujo de aprobación.

### 4.2 OpenSpec (especificaciones vivas)
Mantener una “especificación viva” dentro del repo (y/o Notion) que incluya:
* Specs por módulo (M1..M10) con criterios de aceptación
* Contratos de API (webhook WhatsApp, server actions internas)
* Decisiones arquitectónicas (ADRs)
* Trazabilidad: cada tarea de desarrollo referencia un spec y un criterio de aceptación
Salida exigida de diseño: estructura de carpetas OpenSpec + plantilla de spec.

---

## 5) Requisitos no funcionales (NFR) — ajustados a proyecto simple
* Deploy: VPS Ubuntu LTS con Docker + reverse proxy + TLS.
* Performance: bandeja usable con 500–2,000 mensajes/día.
* Realtime: usar Supabase Realtime para mensajes y estados cuando sea viable; fallback a polling.
* Resiliencia: reintentos con backoff para envíos WhatsApp + cola simple.
* Seguridad: RLS, validación server-side, rate limiting en webhook.
* Privacidad: no exponer API keys; logs sin PII sensible cuando sea posible.

---

## 6) Stack tecnológico (fijo)
* Next.js 16 (App Router)
* TypeScript
* TailwindCSS
* shadcn/ui
* Supabase (Postgres + Auth + Realtime/Storage si aplica)
* Meta WhatsApp Business Cloud API
* DeepSeek API (LLMs)

---

## 7) Datos (modelo mínimo sugerido)
* users (perfil)
* roles, user_roles (si no se usa solo JWT claims)
* customers
* conversations
* messages
* notes
* opportunities (pipeline simple)
* orders, order_items
* products
* settings (prompts, horarios, config)
* secrets (referencias/metadata cifrada; nunca mostrar valor)
* activity_logs
* engram_feedback, engram_memories (si aplica en v1.1)

---

## 8) UX / Pantallas mínimas
* Login
* Inbox (conversaciones)
* Vista conversación (chat)
* Cliente (perfil)
* Oportunidad (pipeline simple)
* Pedido (crear/editar)
* Admin: WhatsApp + IA (prompts) + DeepSeek keys + settings
* Auditoría

---

## 9) Métricas (mínimas)
* Tiempo medio de primera respuesta
* Conversaciones resueltas/día
* Conversión a pedido
* Pedidos por día/semana
* % conversaciones atendidas por IA vs humano
* Razones de handoff

---

# Fase 0 — Documentación de arranque (OBLIGATORIA, antes de código)
Debes entregar estos documentos primero:
1. OpenSpec/PRD desglosado por módulos (M1–M10) con criterios de aceptación.
1. Arquitectura (diagrama textual): UI → Server Actions → DB → Integraciones (WhatsApp/DeepSeek).
1. Modelo de datos (tablas + relaciones + índices mínimos).
1. Seguridad: RLS por tabla + permisos por rol.
1. Plan de despliegue VPS Ubuntu (Docker compose, TLS, env, backups).
1. Plan IA: prompts, memoria, handoff, guardrails.
1. Plan de tareas: backlog inicial (épicas → historias → tasks) trazadas a specs.
> Recién después de completar y validar esta documentación, puedes empezar a escribir código.

---

## “Preguntas abiertas” (para completar antes de cerrar el diseño)
* Menú/productos y precios (moneda)
* Horarios reales de atención
* Zonas de entrega/retiro + costo de envío
* Método de pago principal (PIX/efectivo/tarjeta)
* Tono de marca (formal/informal) y si se permiten emojis
* Volumen esperado (mensajes/día) y número de operadores

/**
 * Unit test suite for web-only rollout & rollback dry run rehearsal (P7).
 * Verifies wiring markers, ordered plan, service scope, rollback execution, and bounded report.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ModuleKind, transpileModule } from 'typescript'
import { createDockerProcessBoundary } from '../helpers/web-docker-process-boundary'
import { FIXTURE_PROJECT, FIXTURE_SERVICE, FIXTURE_CONTAINER_ID, FIXTURE_INITIAL_IMAGE_ID, FIXTURE_CANDIDATE_IMAGE_ID, FIXTURE_INITIAL_CONFIG_IMAGE, FIXTURE_CANDIDATE_CONFIG_IMAGE, FIXTURE_NETWORK_ID } from '../helpers/web-docker-dispatcher'

const GATES = ['PAYMENT_PROOF_CANONICAL_INGEST_ENABLED', 'WHATSAPP_PAYMENT_PROOF_INGEST_ENABLED', 'TELEGRAM_PAYMENT_PROOF_INGEST_ENABLED', 'PAYMENT_PROOF_PROCESSING_ENABLED', 'PAYMENT_PROOF_SELLER_RECONCILIATION_ENABLED', 'PAYMENT_PROOF_PRIVILEGED_REPLAY_ENABLED', 'PAYMENT_PROOF_CLEANUP_ENABLED', 'PAYMENT_PROOF_RESTORE_ENABLED', 'NOTIFICATION_OUTBOX_DISPATCH_ENABLED', 'WEB_NOTIFICATION_OUTBOX_DISPATCH_ENABLED', 'WHATSAPP_NOTIFICATION_OUTBOX_DISPATCH_ENABLED', 'TELEGRAM_NOTIFICATION_OUTBOX_DISPATCH_ENABLED', 'SOFIA_INBOUND_BATCH_PROCESSING_ENABLED', 'SOFIA_INBOUND_BATCH_RUNTIME_ENABLED', 'SOFIA_INBOUND_BATCH_TELEGRAM_ENQUEUE_ENABLED', 'SOFIA_INBOUND_BATCH_EVOLUTION_ENQUEUE_ENABLED', 'SOFIA_CUSTOMER_MEMORY_ENABLED']

const dispatcherCjs = transpileModule(readFileSync(join(process.cwd(), 'tests/helpers/web-docker-dispatcher.ts'), 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText

export const SURFACE_MARKERS = [
  { name: 'bundle-lifecycle-invocation', test: (d: string) => d.includes('web_only_bundle_lifecycle.py') },
  { name: 'state-publisher-invocation', test: (d: string) => d.includes('web_only_state_publisher.py') },
  { name: 'publisher-expected-project', test: (d: string) => d.includes('--expected-project') },
  { name: 'publisher-expected-endpoint', test: (d: string) => d.includes('--expected-endpoint') },
  { name: 'compose-explicit-project-name', test: (d: string) => d.includes('--project-name') },
  { name: 'exit-cleanup-trap', test: (d: string) => /trap\s+['"].*cleanup_web_only_bundle.*['"]\s+EXIT/.test(d) },
  { name: 'lifecycle-prune-subcommand', test: (_d: string, l: string) => l.includes('add_parser("prune")') },
]
export const checkSurfaceMarkers = (d: string, l: string) => SURFACE_MARKERS.map((m) => ({ name: m.name, found: m.test(d, l) }))

interface Sandbox {
  dir: string; opRoot: string; stateRoot: string; commandsLog: string
  runDeploy: (args: string[], env?: Record<string, string>) => ReturnType<typeof spawnSync>
  cleanup: () => void
}
let sb: Sandbox | null = null
afterEach(() => { sb?.cleanup(); sb = null })
const getCommands = (log: string) => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []

function parseArgs(args: string[]): Record<string, string> {
  const m: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) continue
    const eq = args[i].indexOf('=')
    if (eq !== -1) m[args[i].slice(2, eq)] = args[i].slice(eq + 1)
    else if (i + 1 < args.length && !args[i + 1].startsWith('--')) m[args[i].slice(2)] = args[++i]
    else m[args[i].slice(2)] = 'true'
  }
  return m
}

function assertBundleUp(cmd: { command?: string; args?: string[] } | undefined, stateRoot: string, opRoot: string, kind: 'candidate' | 'rollback') {
  expect(cmd).toBeDefined()
  expect(cmd!.args?.slice(0, 2)).toEqual(['compose', '-f'])
  expect(cmd!.args?.[2]).toMatch(new RegExp(`^${stateRoot}/bundle-[0-9a-fA-F]+/${kind}-compose\\.json$`))
  expect(cmd!.args?.slice(3)).toEqual(['--project-directory', opRoot, '--project-name', FIXTURE_PROJECT, 'up', '-d', '--no-deps', '--force-recreate', FIXTURE_SERVICE])
}

function formatPlan(cmds: { command?: string; args?: string[] }[], sandboxDir: string): string[] {
  const sanitize = (s: string) => s.replaceAll(sandboxDir, '<sandbox>').replaceAll(process.cwd(), '<repo>')
  const steps: string[] = []
  for (const c of cmds) {
    const { command, args = [] } = c
    if (command === 'web_only_bundle_lifecycle.py' && args[0] === 'allocate') steps.push('allocate bundle: private 0700 workspace')
    else if (command === 'web_only_bundle_lifecycle.py' && args[0] === 'validate') steps.push('validate bundle: manifest & compose bindings verified')
    else if (command === 'docker' && ((args[0] === 'image' && args[1] === 'tag') || args[0] === 'tag')) steps.push(`tag rollback ref: ${args[args.length - 1]}`)
    else if (command === 'docker' && args[0] === 'compose' && args.includes('up')) steps.push(`compose up web: ${sanitize(args[2] || '')}`)
    else if (command === 'web_only_state_publisher.py') steps.push(`publish release: atomic v2 state commit (project=${FIXTURE_PROJECT})`)
  }
  return steps.map((s, idx) => `step ${idx + 1}: ${s}`)
}
function createSandbox(): Sandbox {
  const pb = createDockerProcessBoundary()
  const scriptsDir = join(pb.opRoot, 'scripts'), stateRoot = join(pb.dir, 'deploy-state')
  mkdirSync(scriptsDir, { recursive: true, mode: 0o700 }); mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  writeFileSync(join(pb.opRoot, 'docker-compose.yml'), 'services:\n  web:\n    image: crm-sofia-web:latest\n')
  writeFileSync(join(pb.opRoot, '.env'), 'PORT=3000\n')
  const stateFile = join(pb.dir, 'docker-state.json'), bridgeScript = join(pb.dir, 'docker-bridge.cjs')
  const cand2Ref = 'crm-sofia-web:candidate-2', cand2Id = 'sha256:3333333333333333333333333333333333333333333333333333333333333333'
  const bridgeCode = `const fs = require('node:fs'), path = require('node:path'), state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'))
const commandsLog = ${JSON.stringify(pb.commandsLog)}, opRoot = ${JSON.stringify(pb.opRoot)}, project = ${JSON.stringify(FIXTURE_PROJECT)}, service = ${JSON.stringify(FIXTURE_SERVICE)}, containerId = ${JSON.stringify(FIXTURE_CONTAINER_ID)}, netId = ${JSON.stringify(FIXTURE_NETWORK_ID)}, currentImg = ${JSON.stringify(FIXTURE_INITIAL_IMAGE_ID)}, candImg = ${JSON.stringify(FIXTURE_CANDIDATE_IMAGE_ID)}, currentCfg = ${JSON.stringify(FIXTURE_INITIAL_CONFIG_IMAGE)}, candCfg = ${JSON.stringify(FIXTURE_CANDIDATE_CONFIG_IMAGE)}, cand2Cfg = ${JSON.stringify(cand2Ref)}, cand2Img = ${JSON.stringify(cand2Id)}, gates = ${JSON.stringify(GATES)}
const imageIdMap = { [currentCfg]: currentImg, [currentImg]: currentImg, [candCfg]: candImg, [candImg]: candImg, [cand2Cfg]: cand2Img, [cand2Img]: cand2Img }
fs.appendFileSync(commandsLog, JSON.stringify({ command: 'docker', args: process.argv.slice(2) }) + '\\n')
let args = process.argv.slice(2)
if (args[0] === '--host') { if (args[1] !== 'unix:///var/run/docker.sock') { process.stderr.write('deny host\\n'); process.exit(1) }; args = args.slice(2) }
if (args[0] === 'inspect' && args.length === 4 && args[2] === '--format') {
  const activeImg = state.currentImageId || currentImg
  const map = { '{{index .Config.Labels "com.docker.compose.project"}}': project, '{{range .Config.Env}}{{println .}}{{end}}': gates.map(g => g + '=true').join('\\n'), '{{.Id}}': containerId, '{{.Image}}': activeImg }
  if (map[args[3]]) { process.stdout.write(map[args[3]] + '\\n'); process.exit(0) }
  if (args[3].includes('.State')) { process.stdout.write('healthy\\n'); process.exit(0) }
}
if (args[0] === 'inspect' && args.length === 2 && (args[1] === containerId || args[1] === 'crm-sofia-web' || args[1] === 'asados-web')) {
  const activeImg = state.currentImageId || currentImg, activeCfg = state.currentConfigImage || currentCfg, activeCfgFile = state.currentConfigFile || path.join(opRoot, 'docker-compose.yml')
  process.stdout.write(JSON.stringify([{ Id: containerId, Name: '/crm-sofia-web', Image: activeImg, Config: { Image: activeCfg, Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': service, 'com.docker.compose.project.working_dir': opRoot, 'com.docker.compose.project.config_files': activeCfgFile } }, HostConfig: { PortBindings: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '3020' }] }, Binds: [] }, NetworkSettings: { Ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '3020' }] }, Networks: { [project + '_default']: { NetworkID: netId, Aliases: ['asados-web', 'crm-sofia-web'] } } }, Mounts: [] }]) + '\\n')
  process.exit(0)
}
if (args[0] === 'image' && args[1] === 'inspect') {
  const t = args[2], id = imageIdMap[t] || state.currentImageId || currentImg
  if (args.length === 5 && args[3] === '--format' && args[4] === '{{.Id}}') { process.stdout.write(id + '\\n'); process.exit(0) }
  if (args.length === 3) { process.stdout.write(JSON.stringify([{ Id: id, Architecture: 'amd64', Os: 'linux' }]) + '\\n'); process.exit(0) }
}
if ((args[0] === 'image' && args[1] === 'tag') || args[0] === 'tag') process.exit(0)
if (args[0] === 'compose' && args.includes('up')) {
  const fIdx = args.indexOf('-f')
  if (fIdx !== -1 && args[fIdx + 1]) {
    state.currentConfigFile = args[fIdx + 1]
    try {
      const doc = JSON.parse(fs.readFileSync(args[fIdx + 1], 'utf8'))
      if (doc.services && doc.services[service] && doc.services[service].image) {
        state.currentConfigImage = doc.services[service].image
        state.currentImageId = imageIdMap[state.currentConfigImage] || state.currentImageId
      }
    } catch (e) {}
  }
  fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state))
  process.exit(0)
}
${dispatcherCjs}
const dispatcher = exports.createDockerDispatcher({ opRoot, project, service })
dispatcher.setCurrentImageId(state.currentImageId); dispatcher.setCurrentConfigImage(state.currentConfigImage)
const res = dispatcher.runDocker(args)
if (res.status === 0 && args[0] === 'compose' && args.includes('config')) {
  const doc = JSON.parse(res.stdout); doc.services[service].ports[0].host_ip = '127.0.0.1'; res.stdout = JSON.stringify(doc)
}
fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify({ currentImageId: dispatcher.getCurrentImageId(), currentConfigImage: dispatcher.getCurrentConfigImage(), currentConfigFile: state.currentConfigFile }))
if (res.stdout) process.stdout.write(res.stdout); if (res.stderr) process.stderr.write(res.stderr); process.exit(res.status)
`
  writeFileSync(bridgeScript, bridgeCode)

  for (const s of ['workspace-preflight.sh', 'verify-webhook-ingress-limit.sh', 'smoke-production-readonly.sh']) {
    writeFileSync(join(scriptsDir, s), s.startsWith('smoke') ? '#!/bin/sh\n[ "$ASADOS_EXPECTED_IMAGE_ID" != "$FAKE_FAIL_IMAGE_ID" ]\n' : '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  }

  const repo = join(process.cwd(), 'scripts')
  copyFileSync(join(repo, 'deploy-web.sh'), join(scriptsDir, 'deploy-web.sh')); chmodSync(join(scriptsDir, 'deploy-web.sh'), 0o755)
  for (const f of ['web_only_bundle_writer.py', 'web_only_state.py', 'web_only_state_serializer.py', 'web_only_dir.py', 'web_only_bundle_consumer.py', 'web-only-target-preflight.py']) {
    copyFileSync(join(repo, f), join(scriptsDir, f))
  }
  for (const [py, real] of [['web_only_bundle_lifecycle.py', '_real_lifecycle.py'], ['web_only_state_publisher.py', '_real_publisher.py']]) {
    copyFileSync(join(repo, py), join(scriptsDir, real))
    writeFileSync(join(scriptsDir, py), `#!/usr/bin/env python3\nimport os, sys, json, ${real.slice(0, -3)} as m\ncmd = os.environ.get("COMMANDS_LOG")\nif cmd:\n    with open(cmd, "a") as f: f.write(json.dumps({"command": "${py}", "args": sys.argv[1:]}) + "\\n")\nsys.exit(m.main())\n`, { mode: 0o755 })
  }

  const runDeploy = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(join(pb.binDir, 'bash'), [join(scriptsDir, 'deploy-web.sh'), ...args], {
      cwd: pb.opRoot,
      env: { NODE_ENV: 'test',
        PATH: pb.binDir, HOME: pb.dir, TMPDIR: pb.dir, ASADOS_DEPLOY_STATE_ROOT: stateRoot,
        ASADOS_COMPOSE_PROJECT: FIXTURE_PROJECT, ASADOS_WEB_HEALTH_TIMEOUT_SECONDS: '1',
        ASADOS_SOFIA_SCHEDULER_HEALTH_TIMEOUT_SECONDS: '1', PYTHONDONTWRITEBYTECODE: '1',
        PYTHONPATH: scriptsDir, COMMANDS_LOG: pb.commandsLog, ...env,
      },
      encoding: 'utf8', timeout: 15000,
    })
  return { dir: pb.dir, opRoot: pb.opRoot, stateRoot, commandsLog: pb.commandsLog, runDeploy, cleanup: () => pb.cleanup() }
}
describe('web-only-p7-dry-run rollout and rollback rehearsal contracts', () => {
  const repoDeployScript = readFileSync(join(process.cwd(), 'scripts/deploy-web.sh'), 'utf8')
  const repoLifecycleScript = readFileSync(join(process.cwd(), 'scripts/web_only_bundle_lifecycle.py'), 'utf8')

  it('case 1: operational surface check verifies all required wiring markers', () => {
    for (const m of checkSurfaceMarkers(repoDeployScript, repoLifecycleScript)) {
      expect(m.found, `Missing operational marker: ${m.name}`).toBe(true)
    }
  })

  it('case 2: falsifiability confirms check detects mutated script missing publisher marker', () => {
    const mutated = repoDeployScript.replace(/web_only_state_publisher\.py/g, 'tampered_publisher.py')
    const missing = checkSurfaceMarkers(mutated, repoLifecycleScript).filter((m) => !m.found).map((m) => m.name)
    expect(missing).toContain('state-publisher-invocation')
  })

  it('case 3: rollout rehearsal executes in exact order and persists v2 bundle state', () => {
    sb = createSandbox()
    const res = sb.runDeploy(['deploy', '--web-only', FIXTURE_CANDIDATE_CONFIG_IMAGE])
    expect(res.status, `status=${res.status} stderr=${res.stderr}`).toBe(0)

    const cmds = getCommands(sb.commandsLog)
    const valIdx = cmds.findIndex((c) => c.command === 'web_only_bundle_lifecycle.py' && c.args?.[0] === 'validate')
    const tag1Idx = cmds.findIndex((c) => c.command === 'docker' && c.args?.some((a) => a.startsWith('asados-web:rollback-')))
    const tag2Idx = cmds.findIndex((c) => c.command === 'docker' && c.args?.some((a) => a.startsWith('crm-sofia-web:rollback-')))
    const promoIdx = cmds.findIndex((c) => c.command === 'docker' && c.args?.[0] === 'compose' && c.args?.includes('up') && c.args?.[2]?.endsWith('candidate-compose.json'))
    const pubIdx = cmds.findIndex((c) => c.command === 'web_only_state_publisher.py')

    expect(valIdx).toBeGreaterThanOrEqual(0)
    expect(tag1Idx).toBeGreaterThan(valIdx)
    expect(tag2Idx).toBeGreaterThan(tag1Idx)
    expect(promoIdx).toBeGreaterThan(tag2Idx)
    expect(pubIdx).toBeGreaterThan(promoIdx)

    assertBundleUp(cmds[promoIdx], sb.stateRoot, sb.opRoot, 'candidate')

    const flags = parseArgs(cmds[pubIdx].args || [])
    expect(flags['bundle-dir']).toMatch(new RegExp(`^${sb.stateRoot}/bundle-[0-9a-fA-F]+$`))
    expect(flags['manifest-sha256']).toMatch(/^[0-9a-fA-F]{64}$/)
    expect(flags).toMatchObject({
      'state-root': sb.stateRoot, 'previous-id': FIXTURE_INITIAL_IMAGE_ID, 'deployed-id': FIXTURE_CANDIDATE_IMAGE_ID,
      'expected-root': sb.opRoot, 'expected-endpoint': 'unix:///var/run/docker.sock', 'expected-project': FIXTURE_PROJECT,
      'expected-networks': `${FIXTURE_PROJECT}_default`, 'deployed-ref': FIXTURE_CANDIDATE_CONFIG_IMAGE,
      'previous-ref': `asados-web:rollback-${FIXTURE_INITIAL_IMAGE_ID.replace('sha256:', '')}`,
    })

    const state = readFileSync(join(sb.stateRoot, 'release.env'), 'utf8')
    expect(state).toMatch(/^STATE_VERSION=['"]?2['"]?$/m)
    expect(state).toContain(FIXTURE_CANDIDATE_IMAGE_ID)

    const bundles = readdirSync(sb.stateRoot).filter((f) => f.startsWith('bundle-'))
    expect(bundles).toHaveLength(1)
    expect(existsSync(join(sb.stateRoot, bundles[0], 'rollback-compose.json'))).toBe(true)
  })

  it('case 4: web-only scope touches only web service, scheduler untouched, no auto-prune', () => {
    sb = createSandbox()
    expect(sb.runDeploy(['deploy', '--web-only', FIXTURE_CANDIDATE_CONFIG_IMAGE]).status).toBe(0)
    const cmds = getCommands(sb.commandsLog)
    for (const c of cmds.filter((c) => c.command === 'docker' && c.args?.[0] === 'compose' && c.args?.includes('up'))) {
      expect(c.args!.slice(c.args!.indexOf('up') + 1).filter((a) => !a.startsWith('-'))).toEqual(['web'])
    }
    for (const c of cmds) {
      const full = [c.command, ...(c.args || [])].join(' ')
      expect(full).not.toMatch(/scheduler|sofia-inbound-batch-maintenance|--closed-gates/)
    }
    expect(cmds.some((c) => c.args?.includes('prune'))).toBe(false)
    expect(cmds.some((c) => c.command === 'web_only_bundle_lifecycle.py' && c.args?.[0] === 'cleanup')).toBe(false)
    expect(readdirSync(sb.stateRoot).filter((f) => f.startsWith('bundle-'))).toHaveLength(1)
  })

  it('case 5: rollback rehearsal executes rollback compose on probe failure and preserves state', () => {
    sb = createSandbox()
    const stateFile = join(sb.stateRoot, 'release.env'), initialBytes = Buffer.from('STATE_VERSION=1\nPREVIOUS_ID=init\n')
    writeFileSync(stateFile, initialBytes)

    const res = sb.runDeploy(['deploy', '--web-only', FIXTURE_CANDIDATE_CONFIG_IMAGE], { FAKE_FAIL_IMAGE_ID: FIXTURE_CANDIDATE_IMAGE_ID })
    expect(res.status).not.toBe(0)

    const cmds = getCommands(sb.commandsLog)
    const candUp = cmds.find((c) => c.command === 'docker' && c.args?.[0] === 'compose' && c.args?.includes('up') && c.args?.[2]?.includes('candidate-compose.json'))
    const rollUp = cmds.find((c) => c.command === 'docker' && c.args?.[0] === 'compose' && c.args?.includes('up') && c.args?.[2]?.includes('rollback-compose.json'))

    expect(candUp).toBeDefined()
    assertBundleUp(rollUp, sb.stateRoot, sb.opRoot, 'rollback')
    expect(cmds.indexOf(rollUp!)).toBeGreaterThan(cmds.indexOf(candUp!))
    expect(readFileSync(stateFile).equals(initialBytes)).toBe(true)
  })

  it('case 6: bounded report emits compact human-readable plan to stdout under 20 lines', () => {
    sb = createSandbox()
    expect(sb.runDeploy(['deploy', '--web-only', FIXTURE_CANDIDATE_CONFIG_IMAGE]).status).toBe(0)
    const plan = formatPlan(getCommands(sb.commandsLog), sb.dir)
    for (const step of plan) process.stdout.write(step + '\n')
    expect(plan.length).toBeGreaterThan(0)
    expect(plan.length).toBeLessThanOrEqual(20)
    for (const line of plan) {
      expect(line).not.toContain(sb.dir)
      expect(line).not.toContain(process.cwd())
    }
  })

  it('case 7: two consecutive web-only promotions succeed without intervening standard deploy (H-11)', () => {
    sb = createSandbox()
    const CANDIDATE_2_REF = 'crm-sofia-web:candidate-2'
    const CANDIDATE_2_ID = 'sha256:3333333333333333333333333333333333333333333333333333333333333333'

    // First web-only promotion: from initial baseline to candidate 1
    const res1 = sb.runDeploy(['deploy', '--web-only', FIXTURE_CANDIDATE_CONFIG_IMAGE])
    expect(res1.status, `Deploy 1 failed: ${res1.stderr}`).toBe(0)

    const state1 = readFileSync(join(sb.stateRoot, 'release.env'), 'utf8')
    expect(state1).toContain(FIXTURE_CANDIDATE_IMAGE_ID)
    const bundles1 = readdirSync(sb.stateRoot).filter((f) => f.startsWith('bundle-'))
    expect(bundles1).toHaveLength(1)
    const firstBundleDir = join(sb.stateRoot, bundles1[0])

    // Second consecutive web-only promotion: preflight must accept active bundle-1 compose
    const res2 = sb.runDeploy(['deploy', '--web-only', CANDIDATE_2_REF])
    expect(res2.status, `Deploy 2 failed: ${res2.stderr}`).toBe(0)

    const state2 = readFileSync(join(sb.stateRoot, 'release.env'), 'utf8')
    expect(state2).toContain(CANDIDATE_2_ID)
    expect(state2).toContain(`PREVIOUS_ID='${FIXTURE_CANDIDATE_IMAGE_ID}'`)
    expect(state2).not.toContain(`BUNDLE_DIR='${firstBundleDir}'`)

    const bundles2 = readdirSync(sb.stateRoot).filter((f) => f.startsWith('bundle-'))
    expect(bundles2.length).toBeGreaterThanOrEqual(2)
  }, 25000)
})

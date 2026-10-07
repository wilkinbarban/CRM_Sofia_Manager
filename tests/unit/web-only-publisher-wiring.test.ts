/**
 * Dedicated unit test suite for web-only state publisher wiring (B2).
 * Pins production publisher contracts:
 * - Promotion success calls scripts/web_only_state_publisher.py with verified flags
 * - State becomes v2 release state and bundle directory is retained on success
 * - Publisher classification: 0 -> success; 3 -> durability warning; 1 -> rollback; 4 -> unverified
 * - Pre-mutation preflight fault aborts before compose up with no bundle residue
 */
import { describe, expect, it, afterEach } from 'vitest'
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ModuleKind, transpileModule } from 'typescript'
import { createDockerProcessBoundary } from '../helpers/web-docker-process-boundary'
import {
  FIXTURE_PROJECT, FIXTURE_SERVICE, FIXTURE_CONTAINER_ID,
  FIXTURE_INITIAL_IMAGE_ID, FIXTURE_CANDIDATE_IMAGE_ID,
  FIXTURE_INITIAL_CONFIG_IMAGE, FIXTURE_CANDIDATE_CONFIG_IMAGE, FIXTURE_NETWORK_ID,
} from '../helpers/web-docker-dispatcher'

const GATES = [
  'PAYMENT_PROOF_CANONICAL_INGEST_ENABLED', 'WHATSAPP_PAYMENT_PROOF_INGEST_ENABLED', 'TELEGRAM_PAYMENT_PROOF_INGEST_ENABLED', 'PAYMENT_PROOF_PROCESSING_ENABLED', 'PAYMENT_PROOF_SELLER_RECONCILIATION_ENABLED', 'PAYMENT_PROOF_PRIVILEGED_REPLAY_ENABLED', 'PAYMENT_PROOF_CLEANUP_ENABLED', 'PAYMENT_PROOF_RESTORE_ENABLED', 'NOTIFICATION_OUTBOX_DISPATCH_ENABLED', 'WEB_NOTIFICATION_OUTBOX_DISPATCH_ENABLED',
  'WHATSAPP_NOTIFICATION_OUTBOX_DISPATCH_ENABLED', 'TELEGRAM_NOTIFICATION_OUTBOX_DISPATCH_ENABLED', 'SOFIA_INBOUND_BATCH_PROCESSING_ENABLED', 'SOFIA_INBOUND_BATCH_RUNTIME_ENABLED', 'SOFIA_INBOUND_BATCH_TELEGRAM_ENQUEUE_ENABLED', 'SOFIA_INBOUND_BATCH_EVOLUTION_ENQUEUE_ENABLED', 'SOFIA_CUSTOMER_MEMORY_ENABLED',
]

const dispatcherCjs = transpileModule(readFileSync(join(process.cwd(), 'tests/helpers/web-docker-dispatcher.ts'), 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText

interface PublisherSandbox {
  dir: string; opRoot: string; scriptsDir: string; stateRoot: string; commandsLog: string
  runDeploy: (args: string[], env?: Record<string, string>) => ReturnType<typeof spawnSync>
  cleanup: () => void
}

let sb: PublisherSandbox | null = null
afterEach(() => { sb?.cleanup(); sb = null })

function getCommands(logPath: string): { command?: string; args?: string[] }[] {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function parseArgs(args: string[]): Record<string, string> {
  const m: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq !== -1) m[a.slice(2, eq)] = a.slice(eq + 1)
    else if (i + 1 < args.length && !args[i + 1].startsWith('--')) { m[a.slice(2)] = args[i + 1]; i++ }
    else m[a.slice(2)] = 'true'
  }
  return m
}

function assertBundleUp(cmd: { command?: string; args?: string[] } | undefined, stateRoot: string, opRoot: string, kind: 'candidate' | 'rollback') {
  expect(cmd).toBeDefined()
  expect(cmd!.args?.[0]).toBe('compose')
  expect(cmd!.args?.[1]).toBe('-f')
  expect(cmd!.args?.[2]).toMatch(new RegExp(`^${stateRoot}/bundle-[0-9a-fA-F]+/${kind}-compose\\.json$`))
  expect(cmd!.args?.slice(3, 7)).toEqual(['--project-directory', opRoot, '--project-name', FIXTURE_PROJECT])
  expect(cmd!.args?.slice(7)).toEqual(['up', '-d', '--no-deps', '--force-recreate', FIXTURE_SERVICE])
}

function createPublisherSandbox(): PublisherSandbox {
  const pb = createDockerProcessBoundary()
  const scriptsDir = join(pb.opRoot, 'scripts'), stateRoot = join(pb.dir, 'deploy-state')
  mkdirSync(scriptsDir, { recursive: true, mode: 0o700 }); mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  writeFileSync(join(pb.opRoot, 'docker-compose.yml'), 'services:\n  web:\n    image: crm-sofia-web:latest\n')
  writeFileSync(join(pb.opRoot, '.env'), 'PORT=3000\n')

  const stateFile = join(pb.dir, 'docker-state.json'), bridgeScript = join(pb.dir, 'docker-bridge.cjs')
  const bridgeCode = `const fs = require('node:fs'), path = require('node:path')
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'))
const commandsLog = ${JSON.stringify(pb.commandsLog)}, opRoot = ${JSON.stringify(pb.opRoot)}
const project = ${JSON.stringify(FIXTURE_PROJECT)}, service = ${JSON.stringify(FIXTURE_SERVICE)}
const containerId = ${JSON.stringify(FIXTURE_CONTAINER_ID)}, netId = ${JSON.stringify(FIXTURE_NETWORK_ID)}
const currentImg = ${JSON.stringify(FIXTURE_INITIAL_IMAGE_ID)}, candImg = ${JSON.stringify(FIXTURE_CANDIDATE_IMAGE_ID)}
const currentCfg = ${JSON.stringify(FIXTURE_INITIAL_CONFIG_IMAGE)}, candCfg = ${JSON.stringify(FIXTURE_CANDIDATE_CONFIG_IMAGE)}
const gates = ${JSON.stringify(GATES)}

fs.appendFileSync(commandsLog, JSON.stringify({ command: 'docker', args: process.argv.slice(2) }) + '\\n')
let args = process.argv.slice(2)
if (args[0] === '--host') {
  if (args[1] !== 'unix:///var/run/docker.sock') { process.stderr.write('deny host: ' + args[1] + '\\n'); process.exit(1) }
  args = args.slice(2)
}
if (args[0] === 'inspect' && args.length === 4 && args[2] === '--format') {
  if ((args[1] === 'crm-sofia-web' || args[1] === 'asados-web') && args[3] === '{{index .Config.Labels "com.docker.compose.project"}}') { process.stdout.write(project + '\\n'); process.exit(0) }
  if ((args[1] === 'crm-sofia-web' || args[1] === containerId) && args[3] === '{{range .Config.Env}}{{println .}}{{end}}') { process.stdout.write(gates.map(g => g + '=true').join('\\n') + '\\n'); process.exit(0) }
  if (args[3] === '{{.Id}}') { process.stdout.write(containerId + '\\n'); process.exit(0) }
  if (args[3] === '{{.Image}}') { process.stdout.write(currentImg + '\\n'); process.exit(0) }
  if (args[3].includes('.State')) { process.stdout.write((process.env.FAKE_UNHEALTHY === '1' ? 'unhealthy' : 'healthy') + '\\n'); process.exit(0) }
}
if (args[0] === 'inspect' && args.length === 2 && (args[1] === containerId || args[1] === 'crm-sofia-web' || args[1] === 'asados-web')) {
  process.stdout.write(JSON.stringify([{
    Id: containerId, Name: '/crm-sofia-web', Image: currentImg,
    Config: { Image: currentCfg, Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': service, 'com.docker.compose.project.working_dir': opRoot, 'com.docker.compose.project.config_files': path.join(opRoot, 'docker-compose.yml') } },
    HostConfig: { PortBindings: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '3020' }] }, Binds: [] },
    NetworkSettings: { Ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '3020' }] }, Networks: { [project + '_default']: { NetworkID: netId, Aliases: ['asados-web', 'crm-sofia-web'] } } },
    Mounts: [],
  }]) + '\\n')
  process.exit(0)
}
if (args[0] === 'image' && args[1] === 'inspect') {
  const t = args[2]
  if (args.length === 5 && args[3] === '--format' && args[4] === '{{.Id}}') { process.stdout.write(((t === candCfg || t === candImg) ? candImg : currentImg) + '\\n'); process.exit(0) }
  if (args.length === 3) { process.stdout.write(JSON.stringify([{ Id: (t === candCfg || t === candImg) ? candImg : currentImg, Architecture: 'amd64', Os: 'linux' }]) + '\\n'); process.exit(0) }
}
if ((args[0] === 'image' && args[1] === 'tag') || args[0] === 'tag') process.exit(0)
if (args[0] === 'compose' && args.includes('up')) process.exit(0)
${dispatcherCjs}
const dispatcher = exports.createDockerDispatcher({ opRoot, project, service })
dispatcher.setCurrentImageId(state.currentImageId); dispatcher.setCurrentConfigImage(state.currentConfigImage)
const res = dispatcher.runDocker(args)
if (res.status === 0 && args[0] === 'compose' && args.includes('config')) {
  const doc = JSON.parse(res.stdout)
  doc.services[service].ports[0].host_ip = '127.0.0.1'
  res.stdout = JSON.stringify(doc)
}
fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify({
  currentImageId: dispatcher.getCurrentImageId(), currentConfigImage: dispatcher.getCurrentConfigImage(),
}))
if (res.stdout) process.stdout.write(res.stdout); if (res.stderr) process.stderr.write(res.stderr)
process.exit(res.status)
`
  writeFileSync(bridgeScript, bridgeCode)

  for (const s of ['workspace-preflight.sh', 'verify-webhook-ingress-limit.sh', 'smoke-production-readonly.sh']) {
    writeFileSync(join(scriptsDir, s), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  }

  const repoScripts = join(process.cwd(), 'scripts')
  copyFileSync(join(repoScripts, 'deploy-web.sh'), join(scriptsDir, 'deploy-web.sh')); chmodSync(join(scriptsDir, 'deploy-web.sh'), 0o755)
  for (const py of ['web_only_bundle_writer.py', 'web_only_state.py', 'web_only_state_serializer.py', 'web_only_dir.py', 'web_only_bundle_lifecycle.py', 'web_only_bundle_consumer.py']) {
    copyFileSync(join(repoScripts, py), join(scriptsDir, py))
  }
  copyFileSync(join(repoScripts, 'web-only-target-preflight.py'), join(scriptsDir, '_real_preflight.py'))
  writeFileSync(join(scriptsDir, 'web-only-target-preflight.py'), `#!/usr/bin/env python3
import os, sys, json, _real_preflight as rpf
if os.environ.get("FAKE_PREFLIGHT_FAULT") == "exit1":
    sys.stdout.write(json.dumps({"status": "error", "error": "preflight failed"}) + "\\n"); sys.exit(1)
sys.exit(rpf.main())
`, { mode: 0o755 })

  copyFileSync(join(repoScripts, 'web_only_state_publisher.py'), join(scriptsDir, '_real_state_publisher.py'))
  writeFileSync(join(scriptsDir, 'web_only_state_publisher.py'), `#!/usr/bin/env python3
import os, sys, json
cmd_log = os.environ.get("COMMANDS_LOG", "")
if cmd_log:
    with open(cmd_log, "a") as f: f.write(json.dumps({"command": "web_only_state_publisher.py", "args": sys.argv[1:]}) + "\\n")
fault = os.environ.get("FAKE_PUBLISHER_FAULT", "")
faults = {"1": (1, "ERR_PRECOMMIT_FAILED"), "exit1": (1, "ERR_PRECOMMIT_FAILED"), "3": (3, "WARN_POST_COMMIT_SYNC"), "exit3": (3, "WARN_POST_COMMIT_SYNC"), "4": (4, "ERR_TRANSPORT_STDOUT"), "exit4": (4, "ERR_TRANSPORT_STDOUT")}
if fault in faults:
    code, diag = faults[fault]
    sys.stderr.write(diag + "\\n"); sys.stdout.write(json.dumps({"status": "warning" if code == 3 else "error", "committed": code == 3, "durable": False, "error": diag}) + "\\n"); sys.exit(code)
import _real_state_publisher as rsp; sys.exit(rsp.main())
`, { mode: 0o755 })

  const runDeploy = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(join(pb.binDir, 'bash'), [join(scriptsDir, 'deploy-web.sh'), ...args], {
      cwd: pb.opRoot,
      env: {
        PATH: pb.binDir, HOME: pb.dir, TMPDIR: pb.dir,
        ASADOS_DEPLOY_STATE_ROOT: stateRoot, ASADOS_COMPOSE_PROJECT: FIXTURE_PROJECT,
        ASADOS_WEB_HEALTH_TIMEOUT_SECONDS: '1', ASADOS_SOFIA_SCHEDULER_HEALTH_TIMEOUT_SECONDS: '1',
        PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: scriptsDir,
        COMMANDS_LOG: pb.commandsLog,
        ...env,
      },
      encoding: 'utf8', timeout: 15000,
    })
  return { dir: pb.dir, opRoot: pb.opRoot, scriptsDir, stateRoot, commandsLog: pb.commandsLog, runDeploy, cleanup: () => pb.cleanup() }
}

describe('web-only-publisher-wiring B2 publisher wiring contracts', () => {
  it('case 1: success path publishes v2 release state, retains bundle, passes expected flags', () => {
    sb = createPublisherSandbox()
    const res = sb.runDeploy(['deploy', '--web-only', FIXTURE_CANDIDATE_CONFIG_IMAGE])
    expect(res.status, `status=${res.status} stderr=${res.stderr} stdout=${res.stdout}`).toBe(0)

    const cmds = getCommands(sb.commandsLog)
    const upCmds = cmds.filter((c) => c.command === 'docker' && c.args?.[0] === 'compose' && c.args?.includes('up'))
    expect(upCmds).toHaveLength(1)
    assertBundleUp(upCmds[0], sb.stateRoot, sb.opRoot, 'candidate')
    expect(cmds.some((c) => c.args?.[2]?.includes('rollback-compose.json'))).toBe(false)

    const pubCmd = cmds.find((c) => c.command === 'web_only_state_publisher.py' || c.args?.some((a) => a.includes('web_only_state_publisher.py')))
    expect(pubCmd).toBeDefined()
    const flags = parseArgs(pubCmd!.args || [])
    expect(flags['state-root']).toBe(sb.stateRoot)
    expect(flags['bundle-dir']).toMatch(new RegExp(`^${sb.stateRoot}/bundle-[0-9a-fA-F]+$`))
    expect(flags['manifest-sha256']).toMatch(/^[0-9a-fA-F]{64}$/)
    expect(flags['previous-id']).toBe(FIXTURE_INITIAL_IMAGE_ID)
    expect(flags['deployed-id']).toBe(FIXTURE_CANDIDATE_IMAGE_ID)
    expect(flags['expected-root']).toBe(sb.opRoot)
    expect(flags['expected-endpoint']).toBe('unix:///var/run/docker.sock')
    expect(flags['expected-project']).toBe(FIXTURE_PROJECT)
    expect(flags['expected-networks']).toBe(`${FIXTURE_PROJECT}_default`)
    expect(flags['previous-ref']).toBe(`asados-web:rollback-${FIXTURE_INITIAL_IMAGE_ID.replace('sha256:', '')}`)
    expect(flags['deployed-ref']).toBe(FIXTURE_CANDIDATE_CONFIG_IMAGE)

    const statePath = join(sb.stateRoot, 'release.env')
    expect(existsSync(statePath)).toBe(true)
    const stateContent = readFileSync(statePath, 'utf8')
    expect(stateContent).toMatch(/^STATE_VERSION=['"]?2['"]?$/m)
    expect(stateContent).toContain(FIXTURE_CANDIDATE_IMAGE_ID)

    const bundles = readdirSync(sb.stateRoot).filter((f) => f.startsWith('bundle-'))
    expect(bundles.length).toBeGreaterThan(0)
    expect(existsSync(join(sb.stateRoot, bundles[0], 'rollback-compose.json'))).toBe(true)
  })

  it('case 2: publisher exit 1 (rejected precommit) triggers rollback compose, exits non-zero', () => {
    sb = createPublisherSandbox()
    const res = sb.runDeploy(['deploy', '--web-only', FIXTURE_CANDIDATE_CONFIG_IMAGE], { FAKE_PUBLISHER_FAULT: 'exit1' })
    expect(res.status).not.toBe(0)

    const cmds = getCommands(sb.commandsLog)
    const candUp = cmds.find((c) => c.command === 'docker' && c.args?.[0] === 'compose' && c.args?.includes('up') && c.args?.[2]?.includes('candidate-compose.json'))
    const rollUp = cmds.find((c) => c.command === 'docker' && c.args?.[0] === 'compose' && c.args?.includes('up') && c.args?.[2]?.includes('rollback-compose.json'))
    expect(candUp).toBeDefined()
    assertBundleUp(rollUp, sb.stateRoot, sb.opRoot, 'rollback')
    expect(cmds.indexOf(rollUp!)).toBeGreaterThan(cmds.indexOf(candUp!))
  })

  it('case 3: publisher exit 3 (post-commit warning) does not roll back, exits 0 with stderr warning', () => {
    sb = createPublisherSandbox()
    const res = sb.runDeploy(['deploy', '--web-only', FIXTURE_CANDIDATE_CONFIG_IMAGE], { FAKE_PUBLISHER_FAULT: 'exit3' })
    expect(res.status).toBe(0)

    const cmds = getCommands(sb.commandsLog)
    expect(cmds.some((c) => c.args?.[2]?.includes('candidate-compose.json'))).toBe(true)
    expect(cmds.some((c) => c.args?.[2]?.includes('rollback-compose.json'))).toBe(false)
    expect(res.stderr).toMatch(/WARN_POST_COMMIT_SYNC|post-commit|durability/i)
  })

  it('case 4: publisher exit 4 (unverified) does not roll back and exits non-zero', () => {
    sb = createPublisherSandbox()
    const res = sb.runDeploy(['deploy', '--web-only', FIXTURE_CANDIDATE_CONFIG_IMAGE], { FAKE_PUBLISHER_FAULT: 'exit4' })
    expect(res.status).not.toBe(0)

    const cmds = getCommands(sb.commandsLog)
    expect(cmds.some((c) => c.args?.[2]?.includes('candidate-compose.json'))).toBe(true)
    expect(cmds.some((c) => c.args?.[2]?.includes('rollback-compose.json'))).toBe(false)
    expect(readdirSync(sb.stateRoot).some((f) => f.startsWith('bundle-'))).toBe(true)
  })

  it('case 5: pre-mutation preflight fault aborts before compose up, exits non-zero, cleans bundle', () => {
    sb = createPublisherSandbox()
    const res = sb.runDeploy(['deploy', '--web-only', FIXTURE_CANDIDATE_CONFIG_IMAGE], { FAKE_PREFLIGHT_FAULT: 'exit1' })
    expect(res.status).not.toBe(0)

    const cmds = getCommands(sb.commandsLog)
    expect(cmds.some((c) => c.args?.[0] === 'compose' && c.args?.includes('up'))).toBe(false)
    expect(cmds.some((c) => c.args?.[2]?.includes('candidate-compose') || c.args?.[2]?.includes('rollback-compose'))).toBe(false)
    expect(readdirSync(sb.stateRoot).some((f) => f.startsWith('bundle-'))).toBe(false)
    expect(existsSync(join(sb.stateRoot, 'release.env'))).toBe(false)
  })
})

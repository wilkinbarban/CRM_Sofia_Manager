/**
 * A1b-2 Subprocess Bridge test suite: real spawned process bridge to certified Docker dispatcher.
 * Part of autonomous A1b chain:
 * - A1b-1: Hermetic process & filesystem boundary fixture (tests/helpers/web-docker-process-boundary.ts).
 * - A1b-2: Subprocess bridge connecting spawned binDir/docker to certified dispatcher semantics
 *   (tests/helpers/web-docker-dispatcher.ts) with persistent lifecycle state across separate spawns.
 *
 * PROVENANCE & HARNESS DESIGN:
 * 1. Readonly Queries: ps filter, inspect JSON & formats, image inspect, network inspect, compose config.
 * 2. Strict Rejections: unknown subcommands, mutations, malformed inspect/ps/network/compose with dispatcher denial stderr.
 * 3. Lifecycle Transitions: exact 8-token candidate/rollback compose up transitions across separate spawned processes,
 *    persisting state between distinct executions, read back via inspect queries and boundary state surface.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  FIXTURE_PROJECT,
  FIXTURE_SERVICE,
  FIXTURE_CONTAINER_ID,
  FIXTURE_INITIAL_IMAGE_ID,
  FIXTURE_CANDIDATE_IMAGE_ID,
  FIXTURE_INITIAL_CONFIG_IMAGE,
  FIXTURE_CANDIDATE_CONFIG_IMAGE,
  FIXTURE_NETWORK_ID,
} from '../helpers/web-docker-dispatcher'
import type {
  DockerProcessBoundary,
  WebDockerProcessBoundaryHelper,
} from '../helpers/web-docker-process-boundary'

export interface BridgeDockerProcessBoundary extends DockerProcessBoundary {
  getCurrentImageId?: () => string
  getCurrentConfigImage?: () => string
}

export interface WebDockerBridgeHelper extends WebDockerProcessBoundaryHelper {
  createDockerProcessBoundary: (ambientEnv?: NodeJS.ProcessEnv) => BridgeDockerProcessBoundary
}

const HELPER_PATH = join(import.meta.dirname, '../helpers/web-docker-process-boundary.ts')
const helperExists = existsSync(HELPER_PATH)
let helperModule: WebDockerBridgeHelper | null = null

if (helperExists) {
  helperModule = (await import('../helpers/web-docker-process-boundary')) as WebDockerBridgeHelper
}

function getHelper(): WebDockerBridgeHelper {
  if (!helperExists || !helperModule) {
    throw new Error(
      `web-docker-process-boundary capability missing: ${HELPER_PATH} does not exist. ` +
      'Independent capability RED prerequisite: helper must be implemented before behavior contracts run.'
    )
  }
  return helperModule
}

let boundary: BridgeDockerProcessBoundary | null = null

afterEach(() => {
  if (boundary) {
    boundary.cleanup()
    boundary = null
  }
})

describe('web-docker-bridge A1b-2: subprocess bridge to certified dispatcher and state lifecycle', () => {
  it('executes exact readonly docker queries through spawned bridge processes without mutating state', () => {
    const { createDockerProcessBoundary } = getHelper()
    boundary = createDockerProcessBoundary()

    // 1. Initial state readback via boundary surface before any queries
    expect(boundary.getCurrentImageId?.()).toBe(FIXTURE_INITIAL_IMAGE_ID)
    expect(boundary.getCurrentConfigImage?.()).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)

    // 2. ps query with exact compose project and service filters
    const psRes = boundary.runDocker([
      'ps', '-aq',
      '--filter', `label=com.docker.compose.project=${FIXTURE_PROJECT}`,
      '--filter', `label=com.docker.compose.service=${FIXTURE_SERVICE}`,
    ])
    expect(psRes.status).toBe(0)
    expect(psRes.stdout.trim()).toBe(FIXTURE_CONTAINER_ID)
    expect(psRes.stderr).toBe('')

    // 3. container inspect full JSON schema
    const inspectRes = boundary.runDocker(['inspect', 'crm-sofia-web'])
    expect(inspectRes.status).toBe(0)
    expect(inspectRes.stderr).toBe('')
    const [container] = JSON.parse(inspectRes.stdout)
    expect(container.Id).toBe(FIXTURE_CONTAINER_ID)
    expect(container.Name).toBe('/crm-sofia-web')
    expect(container.Image).toBe(FIXTURE_INITIAL_IMAGE_ID)
    expect(container.Config.Image).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)
    expect(container.Config.Labels['com.docker.compose.project']).toBe(FIXTURE_PROJECT)
    expect(container.Config.Labels['com.docker.compose.service']).toBe(FIXTURE_SERVICE)

    // 4. container inspect format queries
    const imgFmt = boundary.runDocker(['inspect', 'crm-sofia-web', '--format', '{{.Image}}'])
    expect(imgFmt.status).toBe(0)
    expect(imgFmt.stdout.trim()).toBe(FIXTURE_INITIAL_IMAGE_ID)

    const cfgFmt = boundary.runDocker(['inspect', 'crm-sofia-web', '--format', '{{.Config.Image}}'])
    expect(cfgFmt.status).toBe(0)
    expect(cfgFmt.stdout.trim()).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)

    // 5. image inspect queries for initial and candidate images
    const initImgRes = boundary.runDocker(['image', 'inspect', FIXTURE_INITIAL_IMAGE_ID])
    expect(initImgRes.status).toBe(0)
    const [initImg] = JSON.parse(initImgRes.stdout)
    expect(initImg.Id).toBe(FIXTURE_INITIAL_IMAGE_ID)
    expect(initImg.Architecture).toBe('amd64')
    expect(initImg.Os).toBe('linux')

    const candImgRes = boundary.runDocker(['image', 'inspect', FIXTURE_CANDIDATE_IMAGE_ID])
    expect(candImgRes.status).toBe(0)
    const [candImg] = JSON.parse(candImgRes.stdout)
    expect(candImg.Id).toBe(FIXTURE_CANDIDATE_IMAGE_ID)
    expect(candImg.Architecture).toBe('amd64')
    expect(candImg.Os).toBe('linux')

    // 6. network inspect query
    const netRes = boundary.runDocker(['network', 'inspect', FIXTURE_NETWORK_ID])
    expect(netRes.status).toBe(0)
    const [net] = JSON.parse(netRes.stdout)
    expect(net.Id).toBe(FIXTURE_NETWORK_ID)
    expect(net.Name).toBe(`${FIXTURE_PROJECT}_default`)
    expect(net.Labels['com.docker.compose.project']).toBe(FIXTURE_PROJECT)

    // 7. compose config schemas (default, candidate, rollback)
    const defCfg = boundary.runDocker([
      'compose', '--project-directory', boundary.opRoot, '--env-file', join(boundary.opRoot, '.env'),
      '-f', join(boundary.opRoot, 'docker-compose.yml'), '--project-name', FIXTURE_PROJECT, 'config', '--format', 'json',
    ])
    expect(defCfg.status).toBe(0)
    const defDoc = JSON.parse(defCfg.stdout)
    expect(defDoc.services.web.image).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)
    expect(defDoc.services.web.ports).toEqual([{ mode: 'ingress', target: 3000, published: '3020', protocol: 'tcp' }])
    expect(defDoc.networks.default.name).toBe(`${FIXTURE_PROJECT}_default`)

    const candCfg = boundary.runDocker([
      'compose', '-f', join(boundary.opRoot, 'candidate-compose.yml'), 'config', '--format', 'json',
    ])
    expect(candCfg.status).toBe(0)
    const candDoc = JSON.parse(candCfg.stdout)
    expect(candDoc.services.web.image).toBe(FIXTURE_CANDIDATE_CONFIG_IMAGE)
    expect(candDoc.services.web.ports).toEqual([{ mode: 'ingress', target: 3000, published: '3020', protocol: 'tcp' }])

    const rollCfg = boundary.runDocker([
      'compose', '-f', join(boundary.opRoot, 'rollback-compose.yml'), 'config', '--format', 'json',
    ])
    expect(rollCfg.status).toBe(0)
    const rollDoc = JSON.parse(rollCfg.stdout)
    expect(rollDoc.services.web.image).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)
    expect(rollDoc.services.web.ports).toEqual([{ mode: 'ingress', target: 3000, published: '3020', protocol: 'tcp' }])

    // State invariant preserved after all readonly queries
    expect(boundary.getCurrentImageId?.()).toBe(FIXTURE_INITIAL_IMAGE_ID)
    expect(boundary.getCurrentConfigImage?.()).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)
  })

  it('strictly rejects unknown subcommands, unauthorized mutations, and malformed argv with dispatcher denials', () => {
    const { createDockerProcessBoundary } = getHelper()
    boundary = createDockerProcessBoundary()

    expect(boundary.getCurrentImageId?.()).toBe(FIXTURE_INITIAL_IMAGE_ID)
    expect(boundary.getCurrentConfigImage?.()).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)

    const rejectionVectors: Array<{ name: string; args: string[]; expected: RegExp }> = [
      { name: 'unknown subcommand', args: ['unknown-subcommand'], expected: /deny unknown command: unknown-subcommand/i },
      { name: 'mutation run', args: ['run'], expected: /deny mutation: run/i },
      { name: 'mutation rm', args: ['rm'], expected: /deny mutation: rm/i },
      { name: 'mutation tag', args: ['tag'], expected: /deny mutation: tag/i },
      { name: 'mutation build', args: ['build'], expected: /deny mutation: build/i },
      { name: 'mutation push', args: ['push'], expected: /deny mutation: push/i },
      { name: 'mutation down', args: ['down'], expected: /deny mutation: down/i },
      { name: 'unauthorized ps filter', args: ['ps', '-aq'], expected: /deny unauthorized filter/i },
      { name: 'unknown inspect target', args: ['inspect', 'unauthorized-container'], expected: /deny unknown inspect: unauthorized-container/i },
      { name: 'invalid inspect format', args: ['inspect', 'crm-sofia-web', '--format', '{{.Invalid}}'], expected: /deny format/i },
      { name: 'unknown image inspect', args: ['image', 'inspect', 'sha256:0000000000000000000000000000000000000000000000000000000000000000'], expected: /deny unknown image inspect/i },
      { name: 'unknown network inspect', args: ['network', 'inspect', 'unauthorized-network'], expected: /deny network inspect: unauthorized-network/i },
      { name: 'bare compose up', args: ['compose', 'up'], expected: /deny compose up/i },
      { name: 'wrong service compose up', args: ['compose', '-f', join(boundary.opRoot, 'candidate-compose.yml'), 'up', '-d', '--no-deps', '--force-recreate', 'wrong-service'], expected: /deny compose up/i },
      { name: 'foreign path compose up', args: ['compose', '-f', '/foreign/path/compose.yml', 'up', '-d', '--no-deps', '--force-recreate', 'web'], expected: /deny compose up/i },
      { name: 'malformed compose config', args: ['compose', 'config'], expected: /deny compose options/i },
    ]

    for (const vector of rejectionVectors) {
      const res = boundary.runDocker(vector.args)
      expect(res.status, `${vector.name} must return non-zero exit`).not.toBe(0)
      expect(res.stdout, `${vector.name} must produce empty stdout`).toBe('')
      expect(res.stderr, `${vector.name} must contain dispatcher denial`).toMatch(vector.expected)
      expect(res.stderr, `${vector.name} must not use blanket stub message`).not.toContain('execution forbidden')
    }

    // State invariant preserved after all rejection attempts
    expect(boundary.getCurrentImageId?.()).toBe(FIXTURE_INITIAL_IMAGE_ID)
    expect(boundary.getCurrentConfigImage?.()).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)
  })

  it('persists lifecycle state across separate spawned processes through candidate up and rollback up transitions', () => {
    const { createDockerProcessBoundary } = getHelper()
    boundary = createDockerProcessBoundary()

    // 1. Initial state verification before any transitions
    expect(boundary.getCurrentImageId?.()).toBe(FIXTURE_INITIAL_IMAGE_ID)
    expect(boundary.getCurrentConfigImage?.()).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)

    const initImg = boundary.runDocker(['inspect', 'crm-sofia-web', '--format', '{{.Image}}'])
    expect(initImg.status).toBe(0)
    expect(initImg.stdout.trim()).toBe(FIXTURE_INITIAL_IMAGE_ID)

    const initCfg = boundary.runDocker(['inspect', 'crm-sofia-web', '--format', '{{.Config.Image}}'])
    expect(initCfg.status).toBe(0)
    expect(initCfg.stdout.trim()).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)

    // 2. Candidate compose up transition (separate spawned process 1)
    const candCompose = join(boundary.opRoot, 'candidate-compose.yml')
    const candUpRes = boundary.runDocker([
      'compose', '-f', candCompose, 'up', '-d', '--no-deps', '--force-recreate', FIXTURE_SERVICE,
    ])
    expect(candUpRes.status).toBe(0)
    expect(candUpRes.stderr).toBe('')

    // 3. Prove candidate state persists across separate spawned processes (spawns 2, 3, 4)
    const candImgRes = boundary.runDocker(['inspect', 'crm-sofia-web', '--format', '{{.Image}}'])
    expect(candImgRes.status).toBe(0)
    expect(candImgRes.stdout.trim()).toBe(FIXTURE_CANDIDATE_IMAGE_ID)

    const candCfgRes = boundary.runDocker(['inspect', 'crm-sofia-web', '--format', '{{.Config.Image}}'])
    expect(candCfgRes.status).toBe(0)
    expect(candCfgRes.stdout.trim()).toBe(FIXTURE_CANDIDATE_CONFIG_IMAGE)

    const candInspectFull = boundary.runDocker(['inspect', 'crm-sofia-web'])
    expect(candInspectFull.status).toBe(0)
    const [candContainer] = JSON.parse(candInspectFull.stdout)
    expect(candContainer.Image).toBe(FIXTURE_CANDIDATE_IMAGE_ID)
    expect(candContainer.Config.Image).toBe(FIXTURE_CANDIDATE_CONFIG_IMAGE)

    // Read back through the boundary surface
    expect(boundary.getCurrentImageId?.()).toBe(FIXTURE_CANDIDATE_IMAGE_ID)
    expect(boundary.getCurrentConfigImage?.()).toBe(FIXTURE_CANDIDATE_CONFIG_IMAGE)

    // 4. Rollback compose up transition (separate spawned process 5)
    const rollCompose = join(boundary.opRoot, 'rollback-compose.yml')
    const rollUpRes = boundary.runDocker([
      'compose', '-f', rollCompose, 'up', '-d', '--no-deps', '--force-recreate', FIXTURE_SERVICE,
    ])
    expect(rollUpRes.status).toBe(0)
    expect(rollUpRes.stderr).toBe('')

    // 5. Prove rolled-back state persists across separate spawned processes (spawns 6, 7, 8)
    const rollImgRes = boundary.runDocker(['inspect', 'crm-sofia-web', '--format', '{{.Image}}'])
    expect(rollImgRes.status).toBe(0)
    expect(rollImgRes.stdout.trim()).toBe(FIXTURE_INITIAL_IMAGE_ID)

    const rollCfgRes = boundary.runDocker(['inspect', 'crm-sofia-web', '--format', '{{.Config.Image}}'])
    expect(rollCfgRes.status).toBe(0)
    expect(rollCfgRes.stdout.trim()).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)

    const rollInspectFull = boundary.runDocker(['inspect', 'crm-sofia-web'])
    expect(rollInspectFull.status).toBe(0)
    const [rollContainer] = JSON.parse(rollInspectFull.stdout)
    expect(rollContainer.Image).toBe(FIXTURE_INITIAL_IMAGE_ID)
    expect(rollContainer.Config.Image).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)

    // Read back through the boundary surface
    expect(boundary.getCurrentImageId?.()).toBe(FIXTURE_INITIAL_IMAGE_ID)
    expect(boundary.getCurrentConfigImage?.()).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)

    // 6. Prove invalid compose up leaves rolled-back state unmodified (separate spawned process 9)
    const invalidUpRes = boundary.runDocker([
      'compose', '-f', candCompose, 'up', '-d', '--no-deps', '--force-recreate', 'wrong-service',
    ])
    expect(invalidUpRes.status).not.toBe(0)
    expect(invalidUpRes.stderr).toMatch(/deny compose up/i)
    expect(boundary.getCurrentImageId?.()).toBe(FIXTURE_INITIAL_IMAGE_ID)
    expect(boundary.getCurrentConfigImage?.()).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)
  })
})

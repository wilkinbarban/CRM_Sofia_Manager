/**
 * A1a Docker Dispatcher Unit 1 test suite: pure in-memory Docker readonly queries & strict argv contracts.
 * Part of 2-unit A1a partition:
 * - Unit 1 (this suite): Readonly queries (ps, inspect, image inspect, network inspect, compose config schemas),
 *   strict argv rejection of unknown commands, forbidden mutations, invalid query flags,
 *   and readonly denial of all compose up invocations in Unit 1.
 * - Unit 2 (deferred): Lifecycle state transitions (compose candidate/rollback up, manual state changes, and
 *   dynamic Image/Config.Image reflections).
 *
 * PROVENANCE & DEFERRED ASSERTION LEDGER:
 * Full backup baseline (269 lines, SHA256 ab9aef6f3dbe451a5cfa8f8ef212418e06ab46c69d4278996e0e966e4bb9eefc),
 * consolidated here in 4dd9654 (Unit 1) and d0d024c (Unit 2). The pre-split artifact
 * directory that held that baseline was retired after verifying this consolidation.
 *
 * 1. Preserved from old 269 test vectors: Case 2 (lines 69-125: mutations, ps filters, compose flags) and Case 4 (lines 205-268: readonly queries & schemas).
 * 2. Deferred to Unit 2: Case 3 (lines 127-203: candidate up, rollback up, manual mutations, dynamic inspect reflections).
 * 3. Runtime Probes (distinguished from old 269 test vectors):
 *    - 9 Negative Query Vectors (it.each table): inspect extra, unknown format, image inspect extra, foreign image, network inspect extra, compose config missing format, un-split ps.
 *    - 3 Bad Compose Up Denial Vectors (it.each table): bare up, wrong service 'other', trailing extra.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type {
  DockerDispatcher,
  WebDockerDispatcherHelper,
} from '../helpers/web-docker-dispatcher'

const HELPER_PATH = join(process.cwd(), 'tests/helpers/web-docker-dispatcher.ts')
const helperExists = existsSync(HELPER_PATH)
let helperModule: WebDockerDispatcherHelper | null = null

if (helperExists) {
  const helperUrl = pathToFileURL(HELPER_PATH).href
  helperModule = (await import(/* @vite-ignore */ helperUrl)) as WebDockerDispatcherHelper
}

function getHelper(): WebDockerDispatcherHelper {
  if (!helperExists || !helperModule) {
    throw new Error(
      `web-docker-dispatcher capability missing: ${HELPER_PATH} does not exist. ` +
      'Independent capability RED prerequisite: helper must be implemented before behavior contracts run.'
    )
  }
  return helperModule
}

let dispatcher: DockerDispatcher | null = null

afterEach(() => {
  dispatcher = null
})

describe('web-docker-dispatcher A1a Unit 1: readonly queries and strict argv contracts', () => {
  it('executes exact readonly docker queries and verifies structured schemas without mutating state', () => {
    const {
      createDockerDispatcher,
      FIXTURE_PROJECT,
      FIXTURE_SERVICE,
      FIXTURE_CONTAINER_ID,
      FIXTURE_INITIAL_IMAGE_ID,
      FIXTURE_CANDIDATE_IMAGE_ID,
      FIXTURE_INITIAL_CONFIG_IMAGE,
      FIXTURE_CANDIDATE_CONFIG_IMAGE,
      FIXTURE_NETWORK_ID,
    } = getHelper()
    dispatcher = createDockerDispatcher()

    // Baseline state before queries
    expect(dispatcher.getCurrentImageId()).toBe(FIXTURE_INITIAL_IMAGE_ID)
    expect(dispatcher.getCurrentConfigImage()).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)

    // 1. ps query with exact compose project and service label filters
    const psRes = dispatcher.runDocker([
      'ps', '-aq',
      '--filter', `label=com.docker.compose.project=${FIXTURE_PROJECT}`,
      '--filter', `label=com.docker.compose.service=${FIXTURE_SERVICE}`,
    ])
    expect(psRes.status).toBe(0)
    expect(psRes.stdout.trim()).toBe(FIXTURE_CONTAINER_ID)

    // 2. container inspect JSON returning structured record with strong values
    const cInspect = dispatcher.runDocker(['inspect', 'crm-sofia-web'])
    expect(cInspect.status).toBe(0)
    const [container] = JSON.parse(cInspect.stdout)
    expect(container.Id).toBe(FIXTURE_CONTAINER_ID)
    expect(container.Name).toBe('/crm-sofia-web')
    expect(container.Image).toBe(FIXTURE_INITIAL_IMAGE_ID)
    expect(container.Config.Image).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)
    expect(container.Config.Labels['com.docker.compose.project']).toBe(FIXTURE_PROJECT)
    expect(container.Config.Labels['com.docker.compose.service']).toBe(FIXTURE_SERVICE)

    // 3. container inspect format queries
    const imgFormat = dispatcher.runDocker(['inspect', 'crm-sofia-web', '--format', '{{.Image}}'])
    expect(imgFormat.status).toBe(0)
    expect(imgFormat.stdout.trim()).toBe(FIXTURE_INITIAL_IMAGE_ID)

    const cfgFormat = dispatcher.runDocker(['inspect', 'crm-sofia-web', '--format', '{{.Config.Image}}'])
    expect(cfgFormat.status).toBe(0)
    expect(cfgFormat.stdout.trim()).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)

    // 4. image inspect queries for candidate and initial images
    const imgInspect = dispatcher.runDocker(['image', 'inspect', FIXTURE_CANDIDATE_IMAGE_ID])
    expect(imgInspect.status).toBe(0)
    const [img] = JSON.parse(imgInspect.stdout)
    expect(img.Id).toBe(FIXTURE_CANDIDATE_IMAGE_ID)
    expect(img.Architecture).toBe('amd64')
    expect(img.Os).toBe('linux')

    const initImgInspect = dispatcher.runDocker(['image', 'inspect', FIXTURE_INITIAL_IMAGE_ID])
    expect(initImgInspect.status).toBe(0)
    const [initImg] = JSON.parse(initImgInspect.stdout)
    expect(initImg.Id).toBe(FIXTURE_INITIAL_IMAGE_ID)
    expect(initImg.Architecture).toBe('amd64')
    expect(initImg.Os).toBe('linux')

    // 5. network inspect returning network record with strong values
    const netInspect = dispatcher.runDocker(['network', 'inspect', FIXTURE_NETWORK_ID])
    expect(netInspect.status).toBe(0)
    const [net] = JSON.parse(netInspect.stdout)
    expect(net.Id).toBe(FIXTURE_NETWORK_ID)
    expect(net.Name).toBe(`${FIXTURE_PROJECT}_default`)
    expect(net.Labels['com.docker.compose.project']).toBe(FIXTURE_PROJECT)

    // 6. default compose config schema
    const cfgRes = dispatcher.runDocker([
      'compose', '--project-directory', dispatcher.opRoot, '--env-file', join(dispatcher.opRoot, '.env'),
      '-f', join(dispatcher.opRoot, 'docker-compose.yml'), '--project-name', FIXTURE_PROJECT, 'config', '--format', 'json',
    ])
    expect(cfgRes.status).toBe(0)
    const cfg = JSON.parse(cfgRes.stdout)
    expect(cfg.services.web.image).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)
    expect(cfg.services.web.ports).toEqual([{ mode: 'ingress', target: 3000, published: '3020', protocol: 'tcp' }])
    expect(cfg.networks.default.name).toBe(`${FIXTURE_PROJECT}_default`)

    // 7. candidate compose config schema (readonly)
    const candCompose = join(dispatcher.opRoot, 'candidate-compose.yml')
    const candCfgRes = dispatcher.runDocker(['compose', '-f', candCompose, 'config', '--format', 'json'])
    expect(candCfgRes.status).toBe(0)
    const candDoc = JSON.parse(candCfgRes.stdout)
    expect(candDoc.services.web.image).toBe(FIXTURE_CANDIDATE_CONFIG_IMAGE)
    expect(candDoc.services.web.ports).toEqual([{ mode: 'ingress', target: 3000, published: '3020', protocol: 'tcp' }])
    expect(candDoc.networks.default.name).toBe(`${FIXTURE_PROJECT}_default`)

    // 8. rollback compose config schema (readonly)
    const rollCompose = join(dispatcher.opRoot, 'rollback-compose.yml')
    const rollCfgRes = dispatcher.runDocker(['compose', '-f', rollCompose, 'config', '--format', 'json'])
    expect(rollCfgRes.status).toBe(0)
    const rollDoc = JSON.parse(rollCfgRes.stdout)
    expect(rollDoc.services.web.image).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)
    expect(rollDoc.services.web.ports).toEqual([{ mode: 'ingress', target: 3000, published: '3020', protocol: 'tcp' }])
    expect(rollDoc.networks.default.name).toBe(`${FIXTURE_PROJECT}_default`)

    // State invariant preserved after all readonly queries
    expect(dispatcher.getCurrentImageId()).toBe(FIXTURE_INITIAL_IMAGE_ID)
    expect(dispatcher.getCurrentConfigImage()).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)
  })

  it('enforces strict argv rejection of unknown commands, mutations, and invalid query flags while preserving state', () => {
    const {
      createDockerDispatcher,
      FIXTURE_PROJECT,
      FIXTURE_SERVICE,
      FIXTURE_INITIAL_IMAGE_ID,
      FIXTURE_INITIAL_CONFIG_IMAGE,
    } = getHelper()
    dispatcher = createDockerDispatcher()

    expect(dispatcher.getCurrentImageId()).toBe(FIXTURE_INITIAL_IMAGE_ID)
    expect(dispatcher.getCurrentConfigImage()).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)

    // Rejects unknown command
    const unknownRes = dispatcher.runDocker(['unknown-subcommand'])
    expect(unknownRes.status).not.toBe(0)
    expect(unknownRes.stderr).toMatch(/deny unknown command/i)

    // Rejects unauthorized mutations
    for (const mutation of ['run', 'rm', 'tag', 'build', 'push', 'down']) {
      const res = dispatcher.runDocker([mutation])
      expect(res.status).not.toBe(0)
      expect(res.stderr).toMatch(/deny mutation/i)
    }

    // Rejects inspect with unknown target
    const invalidInspect = dispatcher.runDocker(['inspect', 'unknown-target-container'])
    expect(invalidInspect.status).not.toBe(0)
    expect(invalidInspect.stderr).toMatch(/deny unknown inspect/i)

    // Negative exact compose checks: wrong project filter
    const wrongProjPs = dispatcher.runDocker([
      'ps', '-aq',
      '--filter', 'label=com.docker.compose.project=unauthorized-project',
      '--filter', `label=com.docker.compose.service=${FIXTURE_SERVICE}`,
    ])
    expect(wrongProjPs.status).not.toBe(0)
    expect(wrongProjPs.stderr).toMatch(/deny/i)

    // Negative exact compose checks: wrong service filter
    const wrongSvcPs = dispatcher.runDocker([
      'ps', '-aq',
      '--filter', `label=com.docker.compose.project=${FIXTURE_PROJECT}`,
      '--filter', 'label=com.docker.compose.service=unauthorized-service',
    ])
    expect(wrongSvcPs.status).not.toBe(0)
    expect(wrongSvcPs.stderr).toMatch(/deny/i)

    // Negative compose config: wrong project name
    const wrongProjCfg = dispatcher.runDocker([
      'compose', '--project-directory', dispatcher.opRoot, '--env-file', join(dispatcher.opRoot, '.env'),
      '-f', join(dispatcher.opRoot, 'docker-compose.yml'), '--project-name', 'wrong-project', 'config', '--format', 'json',
    ])
    expect(wrongProjCfg.status).not.toBe(0)
    expect(wrongProjCfg.stderr).toMatch(/deny/i)

    // Negative compose config: unexpected or additional flags
    const extraFlagCfg = dispatcher.runDocker([
      'compose', '--project-directory', dispatcher.opRoot, '--unexpected-flag', 'config',
    ])
    expect(extraFlagCfg.status).not.toBe(0)
    expect(extraFlagCfg.stderr).toMatch(/deny/i)

    // Negative compose config: invalid option combination
    const invalidComboCfg = dispatcher.runDocker(['compose', 'config', '--invalid-combination'])
    expect(invalidComboCfg.status).not.toBe(0)
    expect(invalidComboCfg.stderr).toMatch(/deny/i)

    // State invariant preserved after invalid commands
    expect(dispatcher.getCurrentImageId()).toBe(FIXTURE_INITIAL_IMAGE_ID)
    expect(dispatcher.getCurrentConfigImage()).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)
  })

  describe('strict argv rejection & unit1 readonly enforcement: 12 negative and bad compose up vectors', () => {
    const negativeVectors: Array<[string, (h: WebDockerDispatcherHelper, root: string) => string[]]> = [
      ['inspect crm-sofia-web extra', () => ['inspect', 'crm-sofia-web', 'extra']],
      ['inspect crm-sofia-web --unknown-format', () => ['inspect', 'crm-sofia-web', '--unknown-format']],
      ['inspect crm-sofia-web --format {{.Unknown}}', () => ['inspect', 'crm-sofia-web', '--format', '{{.Unknown}}']],
      ['inspect crm-sofia-web --format {{.Image}} extra', () => ['inspect', 'crm-sofia-web', '--format', '{{.Image}}', 'extra']],
      ['image inspect candidateImageId extra', (h) => ['image', 'inspect', h.FIXTURE_CANDIDATE_IMAGE_ID, 'extra']],
      ['image inspect foreign-image', () => ['image', 'inspect', 'foreign-image']],
      ['network inspect networkId extra', (h) => ['network', 'inspect', h.FIXTURE_NETWORK_ID, 'extra']],
      ['compose -f candidate path config missing format', (_, root) => ['compose', '-f', join(root, 'candidate-compose.yml'), 'config']],
      ['un-split ps argv', () => ['ps -aq', '--filter', 'label=com.docker.compose.project=crm', '--filter', 'label=com.docker.compose.service=web']],
      ['bare up missing recreation and service flags', (_, root) => ['compose', '-f', join(root, 'candidate-compose.yml'), 'up']],
      ["wrong service literal 'other'", (_, root) => ['compose', '-f', join(root, 'candidate-compose.yml'), 'up', '-d', '--no-deps', '--force-recreate', 'other']],
      ['trailing extra token on valid up', (_, root) => ['compose', '-f', join(root, 'candidate-compose.yml'), 'up', '-d', '--no-deps', '--force-recreate', 'web', 'extra']],
    ]

    it.each(negativeVectors)('denies %s with nonzero exit, empty stdout, deny stderr, and preserved state', (_name, getArgv) => {
      const helper = getHelper()
      const d = helper.createDockerDispatcher()

      expect(d.getCurrentImageId()).toBe(helper.FIXTURE_INITIAL_IMAGE_ID)
      expect(d.getCurrentConfigImage()).toBe(helper.FIXTURE_INITIAL_CONFIG_IMAGE)

      const res = d.runDocker(getArgv(helper, d.opRoot))
      expect(res.status).not.toBe(0)
      expect(res.stdout).toBe('')
      expect(res.stderr).toMatch(/deny/i)

      expect(d.getCurrentImageId()).toBe(helper.FIXTURE_INITIAL_IMAGE_ID)
      expect(d.getCurrentConfigImage()).toBe(helper.FIXTURE_INITIAL_CONFIG_IMAGE)
    })
  })
})

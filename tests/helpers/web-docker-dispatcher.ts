import { join } from 'node:path'

export interface DockerResult {
  status: number
  stdout: string
  stderr: string
}

export interface DockerDispatcherConfig {
  project?: string
  service?: string
  containerId?: string
  initialImageId?: string
  candidateImageId?: string
  initialConfigImage?: string
  candidateConfigImage?: string
  networkId?: string
  opRoot?: string
}

export interface DockerDispatcher {
  readonly opRoot: string
  runDocker: (args: string[]) => DockerResult
  getCurrentImageId: () => string
  getCurrentConfigImage: () => string
}

export interface WebDockerDispatcherHelper {
  FIXTURE_PROJECT: string
  FIXTURE_SERVICE: string
  FIXTURE_CONTAINER_ID: string
  FIXTURE_INITIAL_IMAGE_ID: string
  FIXTURE_CANDIDATE_IMAGE_ID: string
  FIXTURE_INITIAL_CONFIG_IMAGE: string
  FIXTURE_CANDIDATE_CONFIG_IMAGE: string
  FIXTURE_NETWORK_ID: string
  createDockerDispatcher: (config?: DockerDispatcherConfig) => DockerDispatcher
}

export const FIXTURE_PROJECT = 'crm'
export const FIXTURE_SERVICE = 'web'
export const FIXTURE_CONTAINER_ID = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
export const FIXTURE_INITIAL_IMAGE_ID = 'sha256:1111111111111111111111111111111111111111111111111111111111111111'
export const FIXTURE_CANDIDATE_IMAGE_ID = 'sha256:2222222222222222222222222222222222222222222222222222222222222222'
export const FIXTURE_INITIAL_CONFIG_IMAGE = 'crm-sofia-web:current'
export const FIXTURE_CANDIDATE_CONFIG_IMAGE = 'crm-sofia-web:candidate'
export const FIXTURE_NETWORK_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

export function createDockerDispatcher(cfg: DockerDispatcherConfig = {}): DockerDispatcher {
  const project = cfg.project ?? FIXTURE_PROJECT
  const service = cfg.service ?? FIXTURE_SERVICE
  const containerId = cfg.containerId ?? FIXTURE_CONTAINER_ID
  const initialImageId = cfg.initialImageId ?? FIXTURE_INITIAL_IMAGE_ID
  const candidateImageId = cfg.candidateImageId ?? FIXTURE_CANDIDATE_IMAGE_ID
  const initialConfigImage = cfg.initialConfigImage ?? FIXTURE_INITIAL_CONFIG_IMAGE
  const candidateConfigImage = cfg.candidateConfigImage ?? FIXTURE_CANDIDATE_CONFIG_IMAGE
  const networkId = cfg.networkId ?? FIXTURE_NETWORK_ID
  const opRoot = cfg.opRoot ?? '/op-root'

  const ok = (stdout = ''): DockerResult => ({ status: 0, stdout, stderr: '' })
  const deny = (stderr: string): DockerResult => ({ status: 1, stdout: '', stderr })

  const composeDoc = (image: string) => JSON.stringify({
    services: { [service]: { image, ports: [{ mode: 'ingress', target: 3000, published: '3020', protocol: 'tcp' }] } },
    networks: { default: { name: `${project}_default` } },
  })

  return {
    opRoot,
    getCurrentImageId: () => initialImageId,
    getCurrentConfigImage: () => initialConfigImage,
    runDocker(args) {
      const cmd = args[0]
      if (['run', 'rm', 'tag', 'build', 'push', 'down'].includes(cmd)) return deny(`deny mutation: ${cmd}`)
      if (cmd === 'ps') {
        const okPs = args.length === 6 && args[1] === '-aq' &&
          args[2] === '--filter' && args[3] === `label=com.docker.compose.project=${project}` &&
          args[4] === '--filter' && args[5] === `label=com.docker.compose.service=${service}`
        return okPs ? ok(containerId) : deny('deny unauthorized filter')
      }
      if (cmd === 'inspect') {
        if (args[1] !== 'crm-sofia-web' && args[1] !== containerId) return deny(`deny unknown inspect: ${args[1]}`)
        if (args.length === 2) {
          return ok(JSON.stringify([{
            Id: containerId,
            Name: '/crm-sofia-web',
            Image: initialImageId,
            Config: {
              Image: initialConfigImage,
              Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': service },
            },
          }]))
        }
        if (args.length === 4 && args[2] === '--format') {
          if (args[3] === '{{.Image}}') return ok(initialImageId)
          if (args[3] === '{{.Config.Image}}') return ok(initialConfigImage)
        }
        return deny('deny format')
      }
      if (cmd === 'image' && args[1] === 'inspect') {
        if (args.length === 3 && (args[2] === initialImageId || args[2] === candidateImageId)) {
          return ok(JSON.stringify([{ Id: args[2], Architecture: 'amd64', Os: 'linux' }]))
        }
        return deny(`deny unknown image inspect: ${args[2]}`)
      }
      if (cmd === 'network' && args[1] === 'inspect') {
        if (args.length === 3 && args[2] === networkId) {
          return ok(JSON.stringify([{ Id: networkId, Name: `${project}_default`, Labels: { 'com.docker.compose.project': project } }]))
        }
        return deny(`deny network inspect: ${args[2]}`)
      }
      if (cmd === 'compose') {
        if (args.includes('up')) return deny('deny compose up')
        if (args.length === 6 && args[1] === '-f' && args[3] === 'config' && args[4] === '--format' && args[5] === 'json') {
          if (args[2] === join(opRoot, 'candidate-compose.yml')) return ok(composeDoc(candidateConfigImage))
          if (args[2] === join(opRoot, 'rollback-compose.yml')) return ok(composeDoc(initialConfigImage))
        }
        const okDefault = args.length === 12 &&
          args[1] === '--project-directory' && args[2] === opRoot &&
          args[3] === '--env-file' && args[4] === join(opRoot, '.env') &&
          args[5] === '-f' && args[6] === join(opRoot, 'docker-compose.yml') &&
          args[7] === '--project-name' && args[8] === project &&
          args[9] === 'config' && args[10] === '--format' && args[11] === 'json'
        return okDefault ? ok(composeDoc(initialConfigImage)) : deny('deny compose options')
      }
      return deny(`deny unknown command: ${cmd}`)
    },
  }
}

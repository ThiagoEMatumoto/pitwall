// Thin re-export of window.api for ergonomic imports in features.
// Always prefer importing from here so we have a single chokepoint
// for cross-cutting concerns (logging, error wrapping) later.

import type { VideoApi } from '../../shared/types/ipc'

const api = window.api

export const projectsApi = api.projects
export const sessionsApi = api.sessions
export const chatApi = api.chat
export const shellApi = api.shell
export const appApi = api.app
export const gpuApi = api.gpu
export const dialogApi = api.dialog
export const prefsApi = api.prefs
export const secretsApi = api.secrets
export const vaultApi = api.vault
export const fsApi = api.fs
export const repoApi = api.repo
export const workspaceApi = api.workspace
export const ccConfigsApi = api.ccConfigs
export const ccPluginsApi = api.ccPlugins
export const ccSettingsApi = api.ccSettings
export const updatesApi = api.updates
export const usageApi = api.usage
export const metricsApi = api.metrics
export const featuresApi = api.features
export const loopApi = api.loop
export const objectivesApi = api.objectives
export const handoffsApi = api.handoffs
export const batonApi = api.baton
export const dossiersApi = api.dossiers
export const architectureApi = api.repoDeps
export const tasksApi = api.tasks
export const scheduledJobsApi = api.scheduledJobs
export const contentContractsApi = api.contentContracts
export const diagramsApi = api.diagrams
export const meetingsApi = api.meetings
export const windowApi = api.window
export const notificationsApi = api.notifications
export const mcpApi = api.mcp
export const syncApi = api.sync
export const voiceApi = api.voice

// Video Lab: a chave `video` entra em `Api` no commit que implementa o preload.
// Até lá o acesso é por cast pro tipo já declarado na fundação — a UI programa
// contra o contrato, não contra o que já existe em runtime.
export const videoApi = (api as unknown as { video: VideoApi }).video

export { api }

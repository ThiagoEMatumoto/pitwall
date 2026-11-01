import type { DiagramKind } from './types/ipc'
import type { DiagramDirection, DiagramSkeletonElement } from './diagram-skeleton'

// Modelos iniciais de diagrama — skeleton SEM coordenadas: o main posiciona
// com ELK (skeletonToElements), o mesmo caminho do diagram_create do MCP.
// Isomórfico: a UI lista os modelos e o main monta a cena.

export interface DiagramTemplate {
  id: string
  name: string
  description: string
  kind: DiagramKind
  direction: DiagramDirection
  skeleton: DiagramSkeletonElement[]
}

const node = (
  id: string,
  text: string,
  type: 'rectangle' | 'ellipse' | 'diamond' = 'rectangle',
): DiagramSkeletonElement => ({
  id,
  type,
  label: { text },
})

const arrow = (start: string, end: string, label?: string): DiagramSkeletonElement => ({
  id: `${start}->${end}`,
  type: 'arrow',
  start: { id: start },
  end: { id: end },
  ...(label ? { label: { text: label } } : {}),
})

const frame = (id: string, name: string, children: string[]): DiagramSkeletonElement => ({
  id,
  type: 'frame',
  name,
  children,
})

const group = (id: string, label: string, children: string[]): DiagramSkeletonElement => ({
  id,
  type: 'group',
  label: { text: label },
  children,
})

const softwareArchitecture: DiagramTemplate = {
  id: 'software-architecture',
  name: 'Arquitetura de software',
  description: 'Clientes → CDN/API gateway → serviços → banco, cache, fila e storage, em camadas.',
  kind: 'architecture',
  direction: 'LR',
  skeleton: [
    node('web', 'Cliente web'),
    node('mobile', 'App mobile'),
    node('cdn', 'CDN'),
    node('gateway', 'API gateway'),
    node('auth', 'Serviço de auth'),
    node('core', 'Serviço principal'),
    node('worker', 'Worker assíncrono'),
    node('db', 'Banco de dados', 'ellipse'),
    node('cache', 'Cache'),
    node('queue', 'Fila de mensagens'),
    node('storage', 'Object storage'),
    frame('layer-clients', 'Clientes', ['web', 'mobile']),
    frame('layer-edge', 'Borda', ['cdn', 'gateway']),
    frame('layer-services', 'Serviços', ['auth', 'core', 'worker']),
    frame('layer-data', 'Dados', ['db', 'cache', 'queue', 'storage']),
    arrow('web', 'cdn', 'assets'),
    arrow('web', 'gateway', 'HTTPS'),
    arrow('mobile', 'gateway', 'HTTPS'),
    arrow('gateway', 'auth'),
    arrow('gateway', 'core'),
    arrow('auth', 'cache', 'sessões'),
    arrow('core', 'db'),
    arrow('core', 'cache'),
    arrow('core', 'queue', 'eventos'),
    arrow('queue', 'worker'),
    arrow('worker', 'storage'),
    arrow('worker', 'db'),
  ],
}

const mlPipeline: DiagramTemplate = {
  id: 'ml-pipeline',
  name: 'Pipeline de ML',
  description:
    'Fontes → ingestão/ETL → feature store → treino → avaliação → registry → serving → monitoramento, com retreino.',
  kind: 'flow',
  direction: 'LR',
  skeleton: [
    node('src-db', 'Bancos transacionais', 'ellipse'),
    node('src-events', 'Eventos / logs', 'ellipse'),
    node('etl', 'Ingestão / ETL'),
    node('features', 'Feature store'),
    node('train', 'Treino'),
    node('eval', 'Métricas OK?', 'diamond'),
    node('registry', 'Model registry'),
    node('serving', 'Serving / API'),
    node('monitor', 'Monitoramento (drift, latência)'),
    frame('stage-data', 'Dados', ['src-db', 'src-events', 'etl', 'features']),
    frame('stage-training', 'Treino', ['train', 'eval', 'registry']),
    frame('stage-prod', 'Produção', ['serving', 'monitor']),
    arrow('src-db', 'etl'),
    arrow('src-events', 'etl'),
    arrow('etl', 'features'),
    arrow('features', 'train'),
    arrow('train', 'eval'),
    arrow('eval', 'registry', 'sim'),
    arrow('eval', 'train', 'não'),
    arrow('registry', 'serving', 'deploy'),
    arrow('features', 'serving', 'features online'),
    arrow('serving', 'monitor'),
    arrow('monitor', 'train', 'retreino'),
  ],
}

const microservices: DiagramTemplate = {
  id: 'microservices',
  name: 'Microsserviços',
  description: 'Gateway → serviços com banco próprio, integrados por um barramento de eventos.',
  kind: 'architecture',
  direction: 'LR',
  skeleton: [
    node('client', 'Cliente'),
    node('gateway', 'API gateway'),
    node('users', 'Serviço de usuários'),
    node('users-db', 'DB usuários', 'ellipse'),
    node('orders', 'Serviço de pedidos'),
    node('orders-db', 'DB pedidos', 'ellipse'),
    node('payments', 'Serviço de pagamentos'),
    node('payments-db', 'DB pagamentos', 'ellipse'),
    node('bus', 'Barramento de eventos'),
    node('notifications', 'Serviço de notificações'),
    group('svc-users', 'Usuários', ['users', 'users-db']),
    group('svc-orders', 'Pedidos', ['orders', 'orders-db']),
    group('svc-payments', 'Pagamentos', ['payments', 'payments-db']),
    arrow('client', 'gateway'),
    arrow('gateway', 'users'),
    arrow('gateway', 'orders'),
    arrow('gateway', 'payments'),
    arrow('users', 'users-db'),
    arrow('orders', 'orders-db'),
    arrow('payments', 'payments-db'),
    arrow('orders', 'bus', 'pedido criado'),
    arrow('payments', 'bus', 'pagamento aprovado'),
    arrow('bus', 'notifications'),
  ],
}

export const DIAGRAM_TEMPLATES: readonly DiagramTemplate[] = [
  softwareArchitecture,
  mlPipeline,
  microservices,
]

export function findDiagramTemplate(id: string): DiagramTemplate | undefined {
  return DIAGRAM_TEMPLATES.find((t) => t.id === id)
}

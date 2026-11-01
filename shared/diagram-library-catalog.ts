// Catálogo curado de bibliotecas .excalidrawlib — só METADADOS. Nada é
// redistribuído no binário: a instalação baixa o arquivo do repo oficial
// excalidraw/excalidraw-libraries (MIT) no momento do clique.
//
// `source` é o caminho da entrada em libraries.json do repo oficial; a URL raw
// deriva dele. Entradas conferidas contra o índice em 2026-10-31 (todas 200 e
// abaixo do teto de 5 MB do instalador); as de arquitetura de software e ML &
// dados conferidas em 2026-11-01 (baixadas, JSON válido, itens > 0). Se um arquivo sumir do repo, o
// download falha com HTTP 404 e a UI mostra o erro + o link do catálogo.

export type DiagramLibraryCategory =
  | 'cloud'
  | 'uml-er'
  | 'flow'
  | 'architecture'
  | 'software'
  | 'ml-data'

export interface DiagramLibraryCatalogEntry {
  id: string
  name: string
  category: DiagramLibraryCategory
  description: string
  url: string
  source: string
  license: 'MIT'
}

export const DIAGRAM_LIBRARY_RAW_BASE =
  'https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries/'

export const DIAGRAM_LIBRARY_CATALOG_PAGE = 'https://libraries.excalidraw.com'

export const DIAGRAM_LIBRARY_CATEGORY_LABELS: Record<DiagramLibraryCategory, string> = {
  cloud: 'Cloud',
  'uml-er': 'UML/ER',
  flow: 'Fluxo',
  architecture: 'Arquitetura',
  software: 'Arquitetura de software',
  'ml-data': 'ML & dados',
}

function entry(
  id: string,
  name: string,
  category: DiagramLibraryCategory,
  source: string,
  description: string,
): DiagramLibraryCatalogEntry {
  return {
    id,
    name,
    category,
    description,
    source,
    url: `${DIAGRAM_LIBRARY_RAW_BASE}${source}`,
    license: 'MIT',
  }
}

export const DIAGRAM_LIBRARY_CATALOG: readonly DiagramLibraryCatalogEntry[] = [
  entry(
    'aws-architecture',
    'AWS Architecture Icons',
    'cloud',
    'childishgirl/aws-architecture-icons.excalidrawlib',
    'Cerca de 250 ícones de serviços AWS para diagramas de arquitetura.',
  ),
  entry(
    'aws-serverless',
    'AWS Serverless Icons v2',
    'cloud',
    'stojanovic/aws-serverless-icons-v2.excalidrawlib',
    'Lambda, API Gateway, SQS, DynamoDB e outros serviços serverless.',
  ),
  entry(
    'gcp-icons',
    'GCP Icons',
    'cloud',
    'clementbosc/gcp-icons.excalidrawlib',
    'Ícones dos produtos do Google Cloud Platform.',
  ),
  entry(
    'azure-cloud-services',
    'Azure cloud services icons',
    'cloud',
    'youritjang/azure-cloud-services.excalidrawlib',
    'Ícones de vários serviços do Azure.',
  ),
  entry(
    'azure-compute',
    'Azure Compute',
    'cloud',
    '7demonsrising/azure-compute.excalidrawlib',
    'Ícones de computação do portal do Azure: VMs, App Service, Functions.',
  ),
  entry(
    'azure-network',
    'Azure Network',
    'cloud',
    '7demonsrising/azure-network.excalidrawlib',
    'Ícones de rede do portal do Azure: VNet, gateways, balanceadores.',
  ),
  entry(
    'azure-storage',
    'Azure Storage',
    'cloud',
    '7demonsrising/azure-storage.excalidrawlib',
    'Ícones de armazenamento do portal do Azure.',
  ),
  entry(
    'azure-containers',
    'Azure Containers',
    'cloud',
    '7demonsrising/azure-containers.excalidrawlib',
    'Ícones de containers do portal do Azure: AKS, ACR, Container Apps.',
  ),
  entry(
    'uml-er',
    'Shapes for UML & ER Diagrams',
    'uml-er',
    'BjoernKW/UML-ER-library.excalidrawlib',
    'Seleção de shapes para diagramas UML e entidade-relacionamento.',
  ),
  entry(
    'flow-chart-symbols',
    'Flow Chart Symbols',
    'flow',
    'finfin/flow-chart-symbols.excalidrawlib',
    'Símbolos de fluxograma: início/fim, processo, decisão, documento.',
  ),
  entry(
    'c4-architecture',
    'C4 Architecture',
    'architecture',
    'dmitry-burnyshev/c4-architecture.excalidrawlib',
    'Elementos do modelo C4: pessoa, sistema, container, componente.',
  ),
  entry(
    'database',
    'Database',
    'architecture',
    'oehrlis/db-eng.excalidrawlib',
    'Ícones para desenhar infraestrutura de banco de dados.',
  ),
  entry(
    'system-design',
    'System Design Components',
    'software',
    'rohanp/system-design.excalidrawlib',
    'Componentes de system design: cliente, load balancer, cache, fila, banco.',
  ),
  entry(
    'software-architecture',
    'Software Architecture',
    'software',
    'youritjang/software-architecture.excalidrawlib',
    'Microsserviço, banco, cache, event bus e outros blocos de arquitetura.',
  ),
  entry(
    'architecture-diagram-components',
    'Architecture diagram components',
    'software',
    'anna-pastushko/architecture-diagram-components.excalidrawlib',
    'Componentes comuns de diagramas de arquitetura.',
  ),
  entry(
    'basic-system-design',
    'Basic system design',
    'software',
    'pratheeshpm/basic-system-design.excalidrawlib',
    'Modelos prontos de system design para adaptar.',
  ),
  entry(
    'it-icons',
    'IT icons',
    'software',
    'mateuszbaransanok/it-icons.excalidrawlib',
    'Ícones para arquitetura de sistemas de TI: servidores, apps, serviços.',
  ),
  entry(
    'kubernetes-icons',
    'Kubernetes icons',
    'software',
    'boemska-nik/kubernetes-icons.excalidrawlib',
    'Conjunto completo de ícones de arquitetura Kubernetes.',
  ),
  entry(
    'network-topology',
    'Network topology icons',
    'software',
    'dwelle/network-topology-icons.excalidrawlib',
    'Ícones de topologia de rede: roteador, switch, firewall, servidor.',
  ),
  entry(
    'deep-learning',
    'Deep learning',
    'ml-data',
    'yuelfei/deep-learning.excalidrawlib',
    'Camadas e blocos para desenhar redes neurais.',
  ),
  entry(
    'data-science',
    'Data Science logos',
    'ml-data',
    'farisology/data-science.excalidrawlib',
    'Logos de ferramentas de dados: Airflow, Jupyter, Pandas, NumPy, TensorFlow.',
  ),
  entry(
    'data-platform',
    'Data Platform',
    'ml-data',
    'chuqbach/data-platform.excalidrawlib',
    'Ícones do stack de dados: ingestão, warehouse, orquestração, BI.',
  ),
  entry(
    'databricks-architecture',
    'Databricks Architecture Icons',
    'ml-data',
    'lukethorp/databricks-architecture-icons.excalidrawlib',
    'Ícones da plataforma Databricks (arquivo grande, ~4 MB).',
  ),
  entry(
    'data-processing',
    'Data processing',
    'ml-data',
    'erlina/data-processing.excalidrawlib',
    'Itens para visualizar as etapas de processamento de dados.',
  ),
]

export function findCatalogEntry(id: string): DiagramLibraryCatalogEntry | undefined {
  return DIAGRAM_LIBRARY_CATALOG.find((e) => e.id === id)
}

export function findCatalogEntryByUrl(url: string): DiagramLibraryCatalogEntry | undefined {
  return DIAGRAM_LIBRARY_CATALOG.find((e) => e.url === url)
}

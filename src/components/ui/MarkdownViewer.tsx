import type { AnchorHTMLAttributes } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { shellApi } from '@/lib/ipc'
import { perfCount } from '@/lib/perf-probe'
import { CopyButton } from './CopyButton'
import { nodeText, type HastNode } from './markdown-code'
// Tema escuro do highlight.js (estiliza as classes .hljs dos code blocks).
import 'highlight.js/styles/github-dark.css'

// Links de PR/docs no markdown abrem no browser do sistema. Sem isso, o clique
// num <a> puro dispara navegação no Electron e a janela do app some / abre em
// branco em vez de levar a URL pro Chrome.
function MarkdownLink({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      {...rest}
      href={href}
      onClick={(e) => {
        e.preventDefault()
        if (href) void shellApi.openExternal(href)
      }}
    >
      {children}
    </a>
  )
}

// Code block (```...```) com syntax highlight + botão de copiar no hover. Só o
// <pre> (block code) é envolvido; inline `code` segue o estilo padrão.
function CodeBlock({ node, children, ...rest }: { node?: unknown; children?: React.ReactNode }) {
  const code = nodeText(node as HastNode).replace(/\n+$/, '')
  return (
    <div className="group relative">
      <CopyButton
        text={code}
        className="absolute right-2 top-2 opacity-0 transition group-hover:opacity-100"
      />
      <pre
        {...rest}
        className="overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs leading-relaxed"
      >
        {children}
      </pre>
    </div>
  )
}

const MARKDOWN_COMPONENTS: Components = { a: MarkdownLink, pre: CodeBlock }

interface Props {
  content: string
}

export function MarkdownViewer({ content }: Props) {
  perfCount('MarkdownViewer')
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={MARKDOWN_COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

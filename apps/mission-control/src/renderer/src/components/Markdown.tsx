import { Download } from 'lucide-react';
import { useCallback } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

function DownloadableImage({ src, alt }: { src?: string; alt?: string }): JSX.Element {
  const handleDownload = useCallback(async () => {
    if (!src) return;
    try {
      const response = await fetch(src);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Extract filename from URL or use a default
      const urlPath = new URL(src).pathname;
      const filename = urlPath.split('/').pop() || 'image.png';
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      // Fallback: open in external browser
      if (src) window.api.openExternal(src);
    }
  }, [src]);

  return (
    <span className="group/img relative inline-block my-2">
      <img src={src} alt={alt ?? ''} className="max-w-full rounded" />
      <button
        type="button"
        onClick={handleDownload}
        className="absolute top-2 right-2 p-1.5 bg-black/60 text-white/80 rounded opacity-0 group-hover/img:opacity-100 transition-opacity hover:bg-black/80 hover:text-white"
        title="Download image"
      >
        <Download size={14} />
      </button>
    </span>
  );
}

const components: Components = {
  // Open links in external browser via Electron shell
  a({ href, children }) {
    return (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault();
          if (href) window.api.openExternal(href);
        }}
        className="text-primary underline hover:text-primary-hover"
      >
        {children}
      </a>
    );
  },
  // Code blocks and inline code
  pre({ children }) {
    return <pre className="my-2 overflow-x-auto bg-[#161b22] p-3 text-xs">{children}</pre>;
  },
  code({ className, children }) {
    const isBlock = className?.startsWith('hljs');
    if (isBlock) {
      return <code className={className}>{children}</code>;
    }
    return <code className="bg-[#161b22] px-1.5 py-0.5 text-xs text-orange-300">{children}</code>;
  },
  // Images with download button
  img({ src, alt }) {
    return <DownloadableImage src={src} alt={alt} />;
  },
  // Headers
  h1({ children }) {
    return <h1 className="mb-2 mt-4 text-xl font-bold">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="mb-2 mt-3 text-lg font-bold">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="mb-1 mt-2 text-base font-bold">{children}</h3>;
  },
  h4({ children }) {
    return <h4 className="mb-1 mt-2 text-sm font-bold">{children}</h4>;
  },
  // Lists
  ul({ children }) {
    return <ul className="my-1 ml-4 list-disc space-y-0.5">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="my-1 ml-4 list-decimal space-y-0.5">{children}</ol>;
  },
  li({ children }) {
    return <li className="leading-relaxed">{children}</li>;
  },
  // Paragraphs
  p({ children }) {
    return <p className="my-1.5 leading-relaxed">{children}</p>;
  },
  // Blockquotes
  blockquote({ children }) {
    return (
      <blockquote className="my-2 border-l-2 border-muted pl-3 text-muted">{children}</blockquote>
    );
  },
  // Tables
  table({ children }) {
    return (
      <div className="my-2 overflow-x-auto">
        <table className="min-w-full border-collapse text-xs">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return (
      <th className="border border-border bg-sidebar-hover px-3 py-1.5 text-left font-semibold">
        {children}
      </th>
    );
  },
  td({ children }) {
    return <td className="border border-border px-3 py-1.5">{children}</td>;
  },
  // Horizontal rule
  hr() {
    return <hr className="my-3 border-border" />;
  },
  // Strong / em / del
  strong({ children }) {
    return <strong className="font-bold">{children}</strong>;
  },
  em({ children }) {
    return <em className="italic">{children}</em>;
  },
  del({ children }) {
    return <del className="line-through text-muted">{children}</del>;
  },
};

export function Markdown({ children }: { children: string }): JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={components}
    >
      {children}
    </ReactMarkdown>
  );
}

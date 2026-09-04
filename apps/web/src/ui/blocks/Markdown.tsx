import type { ReactNode } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

/**
 * Element map ported 1:1 from Mission Control's
 * `apps/mission-control/src/renderer/src/components/Markdown.tsx` (spec
 * appendix §1), translated from Tailwind utility classes to plain CSS
 * classes (`.md-*` in `apps/web/src/styles.css`) since apps/web has no
 * Tailwind. Two deliberate adaptations from MC, both noted in the task-3
 * report: links use `target="_blank" rel="noopener noreferrer"` instead of
 * Electron's `window.api.openExternal` (there is no Electron shell in a
 * browser tab), and images render as a plain `<img>` with no
 * download-button overlay (that affordance is an Electron-specific
 * convenience with no browser equivalent in this task's scope).
 */
const components: Components = {
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="md-a">
        {children}
      </a>
    );
  },
  pre({ children }) {
    return <pre className="md-pre">{children}</pre>;
  },
  code({ className, children }) {
    const isBlock = className?.startsWith('hljs');
    if (isBlock) {
      return <code className={className}>{children}</code>;
    }
    return <code className="md-code-inline">{children}</code>;
  },
  img({ src, alt }) {
    return <img src={src} alt={alt ?? ''} className="md-img" />;
  },
  h1({ children }) {
    return <h1 className="md-h1">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="md-h2">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="md-h3">{children}</h3>;
  },
  h4({ children }) {
    return <h4 className="md-h4">{children}</h4>;
  },
  ul({ children }) {
    return <ul className="md-ul">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="md-ol">{children}</ol>;
  },
  li({ children }) {
    return <li className="md-li">{children}</li>;
  },
  p({ children }) {
    return <p className="md-p">{children}</p>;
  },
  blockquote({ children }) {
    return <blockquote className="md-blockquote">{children}</blockquote>;
  },
  table({ children }) {
    return (
      <div className="md-table-wrap">
        <table className="md-table">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return <th className="md-th">{children}</th>;
  },
  td({ children }) {
    return <td className="md-td">{children}</td>;
  },
  hr() {
    return <hr className="md-hr" />;
  },
  strong({ children }) {
    return <strong className="md-strong">{children}</strong>;
  },
  em({ children }) {
    return <em className="md-em">{children}</em>;
  },
  del({ children }) {
    return <del className="md-del">{children}</del>;
  },
};

export interface MarkdownProps {
  text: string;
}

/** MC-parity markdown renderer (spec appendix §1). No `rehype-raw` — raw
 * HTML in `text` is never rendered as elements, only shown as escaped text,
 * matching MC's "safe by default" behavior. */
export function Markdown({ text }: MarkdownProps): ReactNode {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={components}
    >
      {text}
    </ReactMarkdown>
  );
}

export default Markdown;

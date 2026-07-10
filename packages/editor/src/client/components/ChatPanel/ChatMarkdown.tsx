import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders one assistant reply's text as markdown — react-markdown never
 * interprets raw HTML in the source by default (no rehype-raw plugin here),
 * so this stays safe against a reply that happens to echo back HTML-looking
 * content (e.g. an HA entity's friendly_name) without any extra
 * sanitization work. remark-gfm adds tables/strikethrough/task-list
 * support, both common in Claude's own replies.
 */
export function ChatMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // Every link opens in a new tab — this panel is a narrow docked
        // sidebar, not a place a user wants to navigate away from. `node`
        // is react-markdown's own hast AST node, passed into every
        // component override alongside real DOM props — it must be pulled
        // out here, not spread onto the actual <a>, or it renders as a
        // literal (and invalid) node="[object Object]" attribute.
        a: ({ children, node, ...props }) => (
          <a {...props} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

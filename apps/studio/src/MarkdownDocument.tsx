import React from "react";

type Block =
  | { type: "heading"; level: number; text: string; key: string }
  | { type: "paragraph"; lines: string[]; key: string }
  | { type: "list"; ordered: boolean; items: string[]; key: string }
  | { type: "blockquote"; lines: string[]; key: string }
  | { type: "code"; text: string; key: string }
  | { type: "table"; headers: string[]; rows: string[][]; key: string };

export function MarkdownDocument({ content }: { content: string }) {
  return (
    <div className="markdownDocument">
      {parseMarkdownBlocks(content).map((block) => renderBlock(block))}
    </div>
  );
}

function renderBlock(block: Block): React.ReactNode {
  if (block.type === "heading") {
    const Tag = `h${Math.min(block.level, 4)}` as keyof JSX.IntrinsicElements;
    return <Tag key={block.key}>{renderInline(block.text, block.key)}</Tag>;
  }
  if (block.type === "paragraph") {
    return <p key={block.key}>{renderInline(block.lines.join(" "), block.key)}</p>;
  }
  if (block.type === "list") {
    const Tag = block.ordered ? "ol" : "ul";
    return (
      <Tag key={block.key}>
        {block.items.map((item, index) => <li key={`${block.key}-${index}`}>{renderInline(item, `${block.key}-${index}`)}</li>)}
      </Tag>
    );
  }
  if (block.type === "blockquote") {
    return <blockquote key={block.key}>{block.lines.map((line, index) => <p key={`${block.key}-${index}`}>{renderInline(line, `${block.key}-${index}`)}</p>)}</blockquote>;
  }
  if (block.type === "code") {
    return <pre className="markdownCode" key={block.key}><code>{block.text}</code></pre>;
  }
  return (
    <div className="markdownTableWrap" key={block.key}>
      <table>
        <thead>
          <tr>{block.headers.map((header, index) => <th key={`${block.key}-h-${index}`}>{renderInline(header, `${block.key}-h-${index}`)}</th>)}</tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={`${block.key}-r-${rowIndex}`}>
              {block.headers.map((_header, cellIndex) => <td key={`${block.key}-r-${rowIndex}-${cellIndex}`}>{renderInline(row[cellIndex] ?? "", `${block.key}-r-${rowIndex}-${cellIndex}`)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function parseMarkdownBlocks(content: string): Block[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  function key() {
    return `md-${blocks.length}-${index}`;
  }

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.trimStart().startsWith("```")) {
      const startKey = key();
      index += 1;
      const code: string[] = [];
      while (index < lines.length && !lines[index].trimStart().startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", text: code.join("\n"), key: startKey });
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim(), key: key() });
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const headers = splitTableRow(lines[index]);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && isTableRow(lines[index])) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: "table", headers, rows, key: key() });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const startKey = key();
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "blockquote", lines: quote, key: startKey });
      continue;
    }

    const unordered = /^\s*[-*]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      const startKey = key();
      const orderedList = Boolean(ordered);
      const items: string[] = [];
      while (index < lines.length) {
        const match = orderedList ? /^\s*\d+\.\s+(.+)$/.exec(lines[index]) : /^\s*[-*]\s+(.+)$/.exec(lines[index]);
        if (!match) break;
        items.push(match[1].trim());
        index += 1;
      }
      blocks.push({ type: "list", ordered: orderedList, items, key: startKey });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !startsNewBlock(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", lines: paragraph, key: key() });
  }

  return blocks;
}

function startsNewBlock(lines: string[], index: number): boolean {
  const line = lines[index];
  return /^(#{1,6})\s+/.test(line) || line.trimStart().startsWith("```") || /^\s*>\s?/.test(line) || /^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line) || isTableStart(lines, index);
}

function isTableStart(lines: string[], index: number): boolean {
  return isTableRow(lines[index]) && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1]);
}

function isTableRow(line: string): boolean {
  return line.includes("|") && line.trim().startsWith("|");
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(<code key={`${keyPrefix}-code-${match.index}`}>{token.slice(1, -1)}</code>);
    } else {
      nodes.push(<strong key={`${keyPrefix}-strong-${match.index}`}>{token.slice(2, -2)}</strong>);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

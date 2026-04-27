export const markdownSnippets = [
  {
    name: 'code-block',
    description: 'Fenced code block',
    body: '```${1:lang}\n$0\n```',
  },
  {
    name: 'link',
    description: 'Markdown link',
    body: '[${1:label}](${2:url})$0',
  },
  {
    name: 'image',
    description: 'Markdown image',
    body: '![${1:alt}](${2:url})$0',
  },
  {
    name: 'table-2col',
    description: 'Two-column Markdown table',
    body: '| ${1:Column A} | ${2:Column B} |\n| --- | --- |\n| ${3:value} | ${4:value} |\n$0',
  },
  {
    name: 'task',
    description: 'Task list item',
    body: '- [ ] ${0}',
  },
  {
    name: 'toc-marker',
    description: 'Tracker table-of-contents marker',
    body: '<!-- orpad:toc -->\n${0}\n<!-- /orpad:toc -->',
  },
  {
    name: 'frontmatter',
    description: 'YAML frontmatter skeleton',
    body: '---\ntitle: ${1:Title}\ndescription: ${2:Description}\ntags:\n  - ${3:tag}\n---\n\n$0',
  },
  {
    name: 'mermaid-flow',
    description: 'Mermaid flowchart block',
    body: '```mermaid\ngraph TD;\n${0}\n```',
  },
];

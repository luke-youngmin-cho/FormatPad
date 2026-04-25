export const mermaidSnippets = [
  {
    name: 'flowchart',
    description: 'Mermaid flowchart',
    body: 'flowchart TD\n  ${1:A}[${2:Start}] --> ${3:B}[${4:Next}]\n$0',
  },
  {
    name: 'sequence',
    description: 'Mermaid sequence diagram',
    body: 'sequenceDiagram\n  participant ${1:A}\n  participant ${2:B}\n  ${1:A}->>${2:B}: ${3:Message}\n$0',
  },
  {
    name: 'class',
    description: 'Mermaid class diagram',
    body: 'classDiagram\n  class ${1:ClassName} \\{\n    +${2:field}\n    +${3:method}()\n  \\}\n$0',
  },
  {
    name: 'er',
    description: 'Mermaid ER diagram',
    body: 'erDiagram\n  ${1:USER} ||--o\\{ ${2:ORDER} : places\n  ${1:USER} \\{\n    string id\n    string name\n  \\}\n$0',
  },
];

export default {
  id: 'adr',
  label: 'Architecture Decision Record',
  description: 'Context, decision, consequences, and alternatives for durable technical choices.',
  filename: (vars) => `adr-${vars.slug(vars.title)}.md`,
  fields: [
    { key: 'title', label: 'Decision title', required: true, placeholder: 'Use local-first storage' },
    { key: 'status', label: 'Status', placeholder: 'Proposed / Accepted / Superseded' },
  ],
  frontmatter: (vars) => ({
    title: vars.title,
    status: vars.status || 'Proposed',
  }),
  requiredSections: ['Status', 'Context', 'Decision', 'Consequences', 'Alternatives'],
  body: (vars) => `# ADR: ${vars.title}

## Status
${vars.status || 'Proposed'}

## Context
_What forces, constraints, and tradeoffs led to this decision?_

## Decision
_State the decision clearly._

## Consequences
- _Positive consequence._
- _Negative or follow-up consequence._

## Alternatives
- _Alternative considered and why it was not chosen._
`,
};

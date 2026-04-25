export default {
  id: 'session-log',
  label: 'Session Log',
  description: 'Prompt/response log with timestamps and decision tags for AI-assisted work.',
  filename: (vars) => `session-log-${new Date().toISOString().slice(0, 10)}-${vars.slug(vars.title || 'work')}.md`,
  fields: [
    { key: 'title', label: 'Session name', required: true, placeholder: 'Template implementation' },
    { key: 'owner', label: 'Author', placeholder: 'Name or role' },
  ],
  frontmatter: (vars) => ({
    title: vars.title,
    owner: vars.owner,
  }),
  requiredSections: ['Session Metadata', 'Prompt / Response Log', 'Decisions', 'Follow-ups'],
  body: (vars) => `# Session Log: ${vars.title}

## Session Metadata
- Started: ${new Date().toISOString()}
- Author: ${vars.owner || '_unset_'}

## Prompt / Response Log
### ${new Date().toISOString()}
**Prompt**

_Paste or summarize the prompt._

**Response**

_Paste or summarize the response._

## Decisions
- [decision] _Decision made during the session._

## Follow-ups
- [ ] _Follow-up item._
`,
};

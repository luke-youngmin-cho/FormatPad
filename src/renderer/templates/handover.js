export default {
  id: 'handover',
  label: 'Handover',
  description: 'Session summary for passing context to the next person or AI conversation.',
  filename: (vars) => `handover-${new Date().toISOString().slice(0, 10)}-${vars.slug(vars.title || 'session')}.md`,
  fields: [
    { key: 'title', label: 'Session / project name', required: true, placeholder: 'OrPAD release prep' },
    { key: 'owner', label: 'Author', placeholder: 'Name or role' },
  ],
  frontmatter: (vars) => ({
    title: vars.title,
    owner: vars.owner,
  }),
  requiredSections: ['Session Summary', 'Context', 'What Done', 'What Next', 'Blockers', 'Files Touched', 'Key Decisions'],
  body: (vars) => `# Handover: ${vars.title}

## Session Summary
_One paragraph summary of the current state._

## Context
- _Important background, constraints, and assumptions._

## What Done
- [ ] _Completed item._

## What Next
- [ ] _Recommended next step._

## Blockers
- _None known._

## Files Touched
- \`path/to/file\` - _why it changed._

## Key Decisions
- [decision] _Decision and rationale._
`,
};

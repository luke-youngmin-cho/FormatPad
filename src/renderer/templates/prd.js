export default {
  id: 'prd',
  label: 'Product Requirements Document',
  description: 'Problem, users, goals, scope, risks, and open questions for a product change.',
  filename: (vars) => `prd-${vars.slug(vars.title)}.md`,
  fields: [
    { key: 'title', label: 'Project / feature name', required: true, placeholder: 'FormatPad AI Templates' },
    { key: 'owner', label: 'Owner', placeholder: 'Product / engineering owner' },
  ],
  frontmatter: (vars) => ({
    title: vars.title,
    owner: vars.owner,
  }),
  requiredSections: ['Problem', 'Users', 'Goals', 'Scope'],
  optionalSections: ['Non-goals', 'Risks', 'Open Questions'],
  body: (vars) => `# ${vars.title}

## Problem
_Describe the core problem and why it matters now._

## Users
- _Primary_:
- _Secondary_:

## Goals
- [ ] _Define the measurable outcome._
- [ ] _Define the user-facing improvement._

## Non-goals
- _Name what this explicitly will not solve._

## Scope
- _In scope:_
- _Out of scope:_

## Risks
- _Risk:_
- _Mitigation:_

## Open Questions
- [ ] _Question that must be answered before implementation._
`,
};

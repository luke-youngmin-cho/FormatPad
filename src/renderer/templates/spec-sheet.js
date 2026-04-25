export default {
  id: 'spec-sheet',
  label: 'Spec Sheet',
  description: 'Implementation spec for endpoints, commands, or module contracts.',
  filename: (vars) => `spec-${vars.slug(vars.title)}.md`,
  fields: [
    { key: 'title', label: 'Spec name', required: true, placeholder: 'Export API' },
    { key: 'owner', label: 'Owner', placeholder: 'Engineering owner' },
  ],
  frontmatter: (vars) => ({
    title: vars.title,
    owner: vars.owner,
  }),
  requiredSections: ['Endpoint', 'Method', 'Request', 'Response', 'Errors', 'Example', 'Tests'],
  body: (vars) => `# Spec Sheet: ${vars.title}

## Endpoint
\`/api/example\`

## Method
\`GET\`

## Request
| Field | Type | Required | Notes |
|---|---|---:|---|
| \`id\` | string | yes | _Describe input._ |

## Response
\`\`\`json
{
  "ok": true
}
\`\`\`

## Errors
| Code | Meaning | Recovery |
|---|---|---|
| 400 | Bad request | _Explain validation failure._ |

## Example
\`\`\`bash
curl -X GET https://example.com/api/example
\`\`\`

## Tests
- [ ] Happy path
- [ ] Validation error
- [ ] Permission / auth edge case
`,
};

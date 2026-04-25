export default {
  id: 'task-list',
  label: 'Task List',
  description: 'Task Master / Linear style checklist with owner and priority markers.',
  filename: (vars) => `tasks-${vars.slug(vars.title)}.md`,
  fields: [
    { key: 'title', label: 'Task list name', required: true, placeholder: 'Release checklist' },
    { key: 'owner', label: 'Default owner', placeholder: '@owner' },
  ],
  frontmatter: (vars) => ({
    title: vars.title,
    owner: vars.owner,
  }),
  requiredSections: ['Tasks', 'Dependencies', 'Import Notes'],
  integrations: ['github', 'linear', 'task-master'],
  body: (vars) => `# Task List: ${vars.title}

## Tasks
- [ ] #001 Title ${vars.owner || '@owner'} !P1
- [ ] #002 Title ${vars.owner || '@owner'} !P2
- [ ] #003 Title ${vars.owner || '@owner'} !P3

## Dependencies
- #001 blocks #002

## Import Notes
Use the template actions to import from GitHub Issues, Linear, or Task Master when the matching MCP server is enabled.
`,
};

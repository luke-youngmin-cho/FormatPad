const PINNED_MCP_PACKAGES = Object.freeze({
  sdk: '@modelcontextprotocol/sdk@1.29.0',
  filesystem: '@modelcontextprotocol/server-filesystem@2026.1.14',
  github: '@modelcontextprotocol/server-github@2025.4.8',
  git: '@cyanheads/git-mcp-server@2.14.2',
});

const DEFAULT_MCP_SERVERS = Object.freeze([
  {
    id: 'filesystem',
    label: 'Filesystem (workspace)',
    transport: 'stdio',
    enabled: false,
    command: 'npx',
    args: ['-y', PINNED_MCP_PACKAGES.filesystem, '${workspacePath}'],
    env: {},
    description: 'Read and search files from the active workspace. Disabled until you opt in.',
    readOnlyDefault: true,
  },
  {
    id: 'git',
    label: 'Git (workspace)',
    transport: 'stdio',
    enabled: false,
    command: 'npx',
    args: ['-y', PINNED_MCP_PACKAGES.git],
    env: {
      GIT_MCP_REPOSITORY: '${workspacePath}',
    },
    description: 'Pinned git MCP fallback. The official @modelcontextprotocol/server-git package was unavailable on npm when this default was added.',
    readOnlyDefault: false,
  },
  {
    id: 'github',
    label: 'GitHub',
    transport: 'stdio',
    enabled: false,
    command: 'npx',
    args: ['-y', PINNED_MCP_PACKAGES.github],
    env: {
      GITHUB_PERSONAL_ACCESS_TOKEN: '${env:GITHUB_PERSONAL_ACCESS_TOKEN}',
      GITHUB_TOKEN: '${env:GITHUB_TOKEN}',
    },
    description: 'GitHub MCP server. Provide a token in your environment before enabling.',
    readOnlyDefault: false,
  },
]);

module.exports = {
  DEFAULT_MCP_SERVERS,
  PINNED_MCP_PACKAGES,
};

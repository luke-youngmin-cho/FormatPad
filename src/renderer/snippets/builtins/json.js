export const jsonSnippets = [
  {
    name: 'object',
    description: 'JSON object',
    body: '\\{\n  "${1:key}": ${2:"value"}\n\\}$0',
  },
  {
    name: 'array',
    description: 'JSON array',
    body: '[\n  ${1:"value"}\n]$0',
  },
  {
    name: 'package-json-min',
    description: 'Minimal package.json',
    body: '\\{\n  "name": "${1:package-name}",\n  "version": "0.1.0",\n  "type": "module",\n  "scripts": \\{\n    "test": "${2:node --test}"\n  \\}\n\\}$0',
  },
  {
    name: 'tsconfig-min',
    description: 'Minimal tsconfig.json',
    body: '\\{\n  "compilerOptions": \\{\n    "target": "ES2022",\n    "module": "ESNext",\n    "strict": true,\n    "moduleResolution": "Bundler"\n  \\},\n  "include": ["${1:src}"]\n\\}$0',
  },
  {
    name: 'eslintrc-min',
    description: 'Minimal ESLint config',
    body: '\\{\n  "root": true,\n  "extends": ["${1:eslint:recommended}"],\n  "env": \\{\n    "browser": true,\n    "es2022": true\n  \\}\n\\}$0',
  },
];

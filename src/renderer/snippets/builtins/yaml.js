export const yamlSnippets = [
  {
    name: 'gh-action-ci-node',
    description: 'GitHub Actions Node CI',
    body: 'name: ${1:CI}\n\non:\n  push:\n    branches: [${2:main}]\n  pull_request:\n\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: ${3:22}\n          cache: npm\n      - run: npm ci\n      - run: npm test\n$0',
  },
  {
    name: 'docker-compose-node',
    description: 'Docker Compose Node service',
    body: 'services:\n  ${1:app}:\n    image: node:${2:22}-alpine\n    working_dir: /app\n    volumes:\n      - .:/app\n    command: ${3:npm run dev}\n    ports:\n      - "${4:3000}:3000"\n$0',
  },
  {
    name: 'k8s-deployment-min',
    description: 'Minimal Kubernetes Deployment',
    body: 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${1:app}\nspec:\n  replicas: ${2:2}\n  selector:\n    matchLabels:\n      app: ${1:app}\n  template:\n    metadata:\n      labels:\n        app: ${1:app}\n    spec:\n      containers:\n        - name: ${1:app}\n          image: ${3:image:tag}\n          ports:\n            - containerPort: ${4:3000}\n$0',
  },
  {
    name: 'kustomization',
    description: 'Kustomize manifest',
    body: 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - ${1:deployment.yaml}\nimages:\n  - name: ${2:app}\n    newTag: ${3:latest}\n$0',
  },
  {
    name: 'renovate',
    description: 'Renovate config',
    body: 'extends:\n  - config:recommended\nlabels:\n  - dependencies\nschedule:\n  - ${1:before 5am on monday}\n$0',
  },
];

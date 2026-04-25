export const envSnippets = [
  {
    name: 'node-basic',
    description: 'Basic Node environment keys',
    body: 'NODE_ENV=${1:development}\nPORT=${2:3000}\nLOG_LEVEL=${3:info}\n$0',
  },
  {
    name: 'supabase-basic',
    description: 'Supabase environment keys',
    body: 'SUPABASE_URL=${1:https://project.supabase.co}\nSUPABASE_ANON_KEY=${2:anon-key}\nSUPABASE_SERVICE_ROLE_KEY=${3:service-role-key}\n$0',
  },
];

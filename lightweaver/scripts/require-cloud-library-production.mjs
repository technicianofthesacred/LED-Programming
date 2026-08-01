const required = [
  'PROJECTS_DB_DATABASE_ID',
  'PROJECT_BLOBS_BUCKET_NAME',
  'ACCESS_TEAM_DOMAIN',
  'ACCESS_AUD',
  'OWNER_EMAILS',
];

const missing = required.filter(name => typeof process.env[name] !== 'string' || !process.env[name].trim());
const invalid = [];

if (process.env.LIGHTWEAVER_PRODUCTION_LIBRARY_READY !== 'confirmed') {
  invalid.push('LIGHTWEAVER_PRODUCTION_LIBRARY_READY=confirmed');
}
if (process.env.PROJECTS_DB_DATABASE_ID
  && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(process.env.PROJECTS_DB_DATABASE_ID.trim())) {
  invalid.push('PROJECTS_DB_DATABASE_ID');
}
if (process.env.PROJECT_BLOBS_BUCKET_NAME
  && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(process.env.PROJECT_BLOBS_BUCKET_NAME.trim())) {
  invalid.push('PROJECT_BLOBS_BUCKET_NAME');
}
if (process.env.ACCESS_AUD && !/^[0-9a-f]{64}$/i.test(process.env.ACCESS_AUD.trim())) {
  invalid.push('ACCESS_AUD');
}
if (process.env.ACCESS_TEAM_DOMAIN) {
  try {
    const url = new URL(process.env.ACCESS_TEAM_DOMAIN.trim());
    if (url.protocol !== 'https:'
      || url.pathname !== '/'
      || !url.hostname.endsWith('.cloudflareaccess.com')) {
      invalid.push('ACCESS_TEAM_DOMAIN');
    }
  } catch {
    invalid.push('ACCESS_TEAM_DOMAIN');
  }
}
if (process.env.OWNER_EMAILS
  && process.env.OWNER_EMAILS.split(',').some(value => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()))) {
  invalid.push('OWNER_EMAILS');
}

if (missing.length || invalid.length) {
  const names = [...new Set([...missing, ...invalid])];
  console.error(`Cloud library production deployment is blocked. Configure: ${names.join(', ')}.`);
  process.exit(1);
}

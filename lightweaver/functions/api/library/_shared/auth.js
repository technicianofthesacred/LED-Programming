import { createRemoteJWKSet, jwtVerify } from 'jose';

const ACCESS_HEADER = 'Cf-Access-Jwt-Assertion';

function requiredSetting(env, name) {
  const value = typeof env?.[name] === 'string' ? env[name].trim() : '';
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function accessIssuer(env) {
  const configured = requiredSetting(env, 'ACCESS_TEAM_DOMAIN');
  const value = configured.includes('://') ? configured : `https://${configured}`;
  const url = new URL(value);
  if (url.protocol !== 'https:'
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash) {
    throw new Error('ACCESS_TEAM_DOMAIN must be an HTTPS origin.');
  }
  return url.origin;
}

function ownerEmails(env) {
  const configured = typeof env?.OWNER_EMAILS === 'string' ? env.OWNER_EMAILS : '';
  return new Set(configured.split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
}

export async function authenticateAccessRequest(request, env, { jwks } = {}) {
  const token = request.headers.get(ACCESS_HEADER);
  if (!token) throw new Error('The Cloudflare Access assertion is missing.');

  const issuer = accessIssuer(env);
  const audience = requiredSetting(env, 'ACCESS_AUD');
  const verificationKey = jwks || createRemoteJWKSet(
    new URL(`${issuer}/cdn-cgi/access/certs`),
  );
  const { payload } = await jwtVerify(token, verificationKey, {
    algorithms: ['RS256'],
    audience,
    clockTolerance: 0,
    issuer,
  });

  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(payload.exp) || payload.exp <= now) {
    throw new Error('The Cloudflare Access assertion is expired.');
  }
  if (payload.type !== 'app') throw new Error('The Cloudflare Access assertion is not an application token.');
  const subject = typeof payload.sub === 'string' ? payload.sub.trim() : '';
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (!subject || !email) throw new Error('The Cloudflare Access identity is incomplete.');

  return {
    email,
    role: ownerEmails(env).has(email) ? 'owner' : 'worker',
    subject,
  };
}

// One-time Google OAuth (Desktop app, loopback redirect + PKCE) -> token.json with a refresh token.
//   1. Put the downloaded OAuth client JSON at ./credentials.json
//   2. node scripts/auth.ts   → open the printed URL, approve, done.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/tasks';
const credFile = process.env.GOOGLE_CREDENTIALS_FILE ?? 'credentials.json';
const tokenFile = process.env.GOOGLE_TOKEN_FILE ?? 'token.json';

let app: any;
try {
  const c = JSON.parse(readFileSync(credFile, 'utf8'));
  app = c.installed ?? c.web;
  if (!app?.client_id) throw new Error('no client_id');
} catch (e) {
  console.error(`Cannot read ${credFile} (${(e as Error).message}). Download the "Desktop app" OAuth client JSON from Google Cloud Console and save it there.`);
  process.exit(1);
}

const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(16).toString('hex');

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://127.0.0.1');
  if (url.pathname !== '/callback') return void res.writeHead(404).end();
  if (url.searchParams.get('state') !== state) return void res.writeHead(400).end('state mismatch');
  const code = url.searchParams.get('code');
  if (!code) return void res.writeHead(400).end(`error: ${url.searchParams.get('error')}`);

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: app.client_id,
      client_secret: app.client_secret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  const tok: any = await r.json();
  if (!r.ok || !tok.refresh_token) {
    res.writeHead(500).end('Token exchange failed, see terminal.');
    console.error('Token exchange failed:', tok);
    process.exit(1);
  }
  writeFileSync(tokenFile, JSON.stringify({ refresh_token: tok.refresh_token, scope: tok.scope, created: new Date().toISOString() }, null, 2));
  chmodSync(tokenFile, 0o600);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<h3>✅ Đã kết nối Google Tasks. Có thể đóng tab này.</h3>');
  console.log(`\n✅ Saved refresh token to ${tokenFile} (chmod 600). Scope: ${tok.scope}`);
  server.close();
});

let redirectUri = '';
server.listen(0, '127.0.0.1', () => {
  redirectUri = `http://127.0.0.1:${(server.address() as any).port}/callback`;
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.search = new URLSearchParams({
    client_id: app.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent', // force a refresh_token every time
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString();
  console.log('Mở link này trong trình duyệt và đăng nhập tài khoản Google của bạn:\n\n' + auth.toString() + '\n\nĐang chờ callback...');
});

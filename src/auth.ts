/**
 * Google OAuth 2.0 for installed apps: loopback redirect + PKCE.
 *
 * The MCP server itself never opens a browser — it only refreshes a token that
 * `npm run auth` stored beforehand. Interactive login belongs to auth-setup.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as crypto from 'crypto';
import { exec } from 'child_process';

const CACHE_DIR = path.join(os.homedir(), '.youtube-mcp');
const TOKEN_PATH = path.join(CACHE_DIR, 'token.json');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

export const SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];

interface StoredToken {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
  token_type: string;
}

interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

function getCredentials(): OAuthCredentials {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set. ' +
        'Copy .env.example to .env and fill in your Google Cloud OAuth desktop-app credentials.',
    );
  }

  return { clientId, clientSecret };
}

function readToken(): StoredToken | null {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function writeToken(token: StoredToken): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

export function hasStoredCredentials(): boolean {
  return readToken() !== null;
}

export function tokenPath(): string {
  return TOKEN_PATH;
}

async function exchange(body: Record<string, string>): Promise<any> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (data as any).error_description ?? (data as any).error ?? `HTTP ${res.status}`;
    throw new Error(`Google token endpoint rejected the request: ${detail}`);
  }
  return data;
}

async function refresh(stored: StoredToken): Promise<StoredToken> {
  const { clientId, clientSecret } = getCredentials();

  const data = await exchange({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: stored.refresh_token,
    grant_type: 'refresh_token',
  });

  const updated: StoredToken = {
    access_token: data.access_token,
    // Google omits refresh_token on refresh responses; keep the existing one.
    refresh_token: data.refresh_token ?? stored.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
    scope: data.scope ?? stored.scope,
    token_type: data.token_type ?? 'Bearer',
  };

  writeToken(updated);
  return updated;
}

/** Returns a valid access token, refreshing if it expires within 60 seconds. */
export async function getAccessToken(): Promise<string> {
  const stored = readToken();

  if (!stored) {
    throw new Error(
      'Not signed in to YouTube. Run "npm run auth" in the youtube-mcp directory once to authorize your Google account.',
    );
  }

  if (Date.now() < stored.expires_at - 60_000) return stored.access_token;

  const refreshed = await refresh(stored);
  return refreshed.access_token;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${cmd} "${url}"`, (err) => {
    if (err) console.error(`Could not open a browser automatically. Open this URL manually:\n${url}`);
  });
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** Runs the interactive browser consent flow and stores the resulting tokens. */
export async function runInteractiveLogin(): Promise<StoredToken> {
  const { clientId, clientSecret } = getCredentials();

  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const state = base64url(crypto.randomBytes(16));

  return new Promise<StoredToken>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      // Google redirects to the loopback root, so accept any path and key off the
      // query instead. Keeps incidental hits like /favicon.ico from ending the flow.
      if (!url.searchParams.has('code') && !url.searchParams.has('error')) {
        res.writeHead(404).end('Not found');
        return;
      }

      const respond = (message: string) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:2rem">
<h2>${message}</h2><p>You can close this tab and return to the terminal.</p></body>`);
      };

      const error = url.searchParams.get('error');
      if (error) {
        respond('Authorization denied.');
        server.close();
        reject(new Error(`Authorization denied: ${error}`));
        return;
      }

      if (url.searchParams.get('state') !== state) {
        respond('State mismatch.');
        server.close();
        reject(new Error('OAuth state mismatch — aborting for safety.'));
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        respond('No authorization code received.');
        server.close();
        reject(new Error('No authorization code in callback.'));
        return;
      }

      try {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;

        const data = await exchange({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          code_verifier: codeVerifier,
          grant_type: 'authorization_code',
          redirect_uri: `http://127.0.0.1:${port}`,
        });

        if (!data.refresh_token) {
          respond('No refresh token returned.');
          server.close();
          reject(
            new Error(
              'Google did not return a refresh token. Revoke the app at ' +
                'https://myaccount.google.com/permissions and run "npm run auth" again.',
            ),
          );
          return;
        }

        const token: StoredToken = {
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
          scope: data.scope ?? SCOPES.join(' '),
          token_type: data.token_type ?? 'Bearer',
        };

        writeToken(token);
        respond('YouTube MCP is now authorized.');
        server.close();
        resolve(token);
      } catch (err) {
        respond('Token exchange failed.');
        server.close();
        reject(err);
      }
    });

    server.on('error', reject);

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      const authUrl = new URL(AUTH_ENDPOINT);
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', `http://127.0.0.1:${port}`);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', SCOPES.join(' '));
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'consent');
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');

      console.log(`Listening on http://127.0.0.1:${port}`);
      console.log(`Opening browser for Google consent...\n${authUrl.toString()}\n`);
      openBrowser(authUrl.toString());
    });
  });
}

/** Revokes the refresh token at Google and deletes the local cache. */
export async function logout(): Promise<void> {
  const stored = readToken();
  if (stored) {
    await fetch(REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: stored.refresh_token }).toString(),
    }).catch(() => undefined);
  }
  if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
}

/**
 * One-time interactive sign-in:  npm run auth
 * Pass --logout to revoke the stored token.
 */
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });

import { runInteractiveLogin, logout, hasStoredCredentials, tokenPath, SCOPES } from './auth.js';
import { getMyChannel } from './youtube-api.js';

async function main() {
  if (process.argv.includes('--logout')) {
    await logout();
    console.log('Signed out. Stored token revoked and deleted.');
    return;
  }

  console.log('=== YouTube MCP – Google Sign-In ===\n');
  console.log(`Scopes: ${SCOPES.join(', ')}\n`);

  if (hasStoredCredentials()) {
    console.log(`An existing token was found at ${tokenPath()} — it will be replaced.\n`);
  }

  await runInteractiveLogin();
  console.log(`\nToken stored at ${tokenPath()} (mode 0600).`);

  try {
    const channel = await getMyChannel();
    console.log(`Signed in as: ${channel.title} (${channel.channelId})`);
  } catch (err: any) {
    console.log(`Signed in, but channel lookup failed: ${err.message}`);
    console.log('This is normal if the Google account has no YouTube channel.');
  }
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});

// Copies the site into deploy/public/converter/ and deploys it with Wrangler.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, '..');
const out = join(here, 'public', 'converter');
const FILES = ['index.html', 'converter.js', 'prusa-profiles.js', 'bambu-profiles.js', 'filaments.js', 'indx-profiles.js', 'browser-indx.js', 'honeycomb-logo.png', 'honeycomb-logo-dark.png'];

rmSync(join(here, 'public'), { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of FILES) cpSync(join(site, f), join(out, f));
console.log(`Copied ${FILES.length} files to ${out}`);

if (!process.argv.includes('--dry')) execSync('npx -y wrangler@4 deploy', { cwd: here, stdio: 'inherit' });

#!/usr/bin/env node
// Builds the static GitHub Pages version into _site/: the web app plus the shared logic in src/,
// which the browser runs directly when there's no server (walking-only routes, no secrets).
import { cpSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = root + '_site';
rmSync(out, { recursive: true, force: true });
cpSync(root + 'public', out, { recursive: true });
cpSync(root + 'src', out + '/src', { recursive: true });
writeFileSync(out + '/.nojekyll', ''); // serve files as-is
console.log('Built _site/');

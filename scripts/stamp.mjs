// Writes dist/version.txt with the branch, commit and build time. Makes every build's file set
// unique, so Cloudflare always uploads a fresh set of static files (when staging and main build
// identical files, it otherwise keeps serving the previous set). Also shows what is live.
import fs from 'node:fs';
const branch = process.env.WORKERS_CI_BRANCH || 'local';
const commit = (process.env.WORKERS_CI_COMMIT_SHA || '').slice(0, 7) || 'local';
fs.writeFileSync(new URL('../dist/version.txt', import.meta.url), `${branch} ${commit} ${new Date().toISOString()}\n`);

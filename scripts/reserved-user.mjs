#!/usr/bin/env node
// Manage who can open which part of the reserved area, and who gets which daily digest.
//   node scripts/reserved-user.mjs set name@example.com press dealflow   (replaces their sections)
//   node scripts/reserved-user.mjs add name@example.com fundraising      (adds sections)
//   node scripts/reserved-user.mjs revoke name@example.com dealflow      (removes sections)
//   node scripts/reserved-user.mjs remove name@example.com               (removes the person)
//   node scripts/reserved-user.mjs digest name@example.com fundraising   (digest for these sections only)
//   node scripts/reserved-user.mjs digest name@example.com off           (no digest emails)
//   node scripts/reserved-user.mjs digest name@example.com all           (digest for all their sections; default)
//   node scripts/reserved-user.mjs list
// Sections: press, fundraising, dealflow. Digests exist for fundraising and dealflow.
// Then commit reserved-users.json; the site redeploys and changes apply immediately.
import fs from 'node:fs';

const SECTIONS = ['press', 'fundraising', 'dealflow'];
const FILE = new URL('../reserved-users.json', import.meta.url);
const [cmd, raw, ...rest] = process.argv.slice(2);
const email = (raw || '').trim().toLowerCase();
const users = JSON.parse(fs.readFileSync(FILE, 'utf8'));

const order = (list) => SECTIONS.filter((s) => list.includes(s));
const get = (e) => {
  const v = users[e];
  if (Array.isArray(v)) return { sections: v, digest: null };
  if (v && typeof v === 'object') return { sections: v.sections || [], digest: Array.isArray(v.digest) ? v.digest : null };
  return { sections: [], digest: null };
};
// Store the short form (a plain list) unless the digest differs from the default.
const put = (e, { sections, digest }) => {
  if (!sections.length) return void delete users[e];
  users[e] = digest === null ? order(sections) : { sections: order(sections), digest: order(digest.filter((s) => sections.includes(s))) };
};

const words = rest.map((s) => s.toLowerCase());
const bad = words.filter((s) => !SECTIONS.includes(s) && !(cmd === 'digest' && ['off', 'all', 'none'].includes(s)));
if (bad.length) fail(`unknown section: ${bad.join(', ')} (use ${SECTIONS.join(', ')})`);
if (['set', 'add', 'revoke', 'remove', 'digest'].includes(cmd) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('give an email address');

const cur = get(email);
if (cmd === 'set' && words.length) put(email, { ...cur, sections: words });
else if (cmd === 'add' && words.length) put(email, { ...cur, sections: [...cur.sections, ...words] });
else if (cmd === 'revoke' && words.length) put(email, { ...cur, sections: cur.sections.filter((s) => !words.includes(s)) });
else if (cmd === 'remove') delete users[email];
else if (cmd === 'digest' && words.length) {
  if (!users[email]) fail(`${email} has no access yet`);
  const digest = words.includes('all') ? null : words.includes('off') || words.includes('none') ? [] : words;
  put(email, { ...cur, digest });
} else if (cmd !== 'list') fail('usage: set|add|revoke <email> <sections...> | digest <email> <sections...|off|all> | remove <email> | list');

if (cmd !== 'list') {
  const sorted = Object.fromEntries(Object.entries(users).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(FILE, JSON.stringify(sorted, null, 2) + '\n');
}
const rows = Object.keys(users).sort().map((e) => {
  const { sections, digest } = get(e);
  const withDigest = sections.filter((s) => s !== 'press');
  const d = digest === null ? (withDigest.length ? `${withDigest.join(', ')} (default)` : '-') : digest.length ? digest.join(', ') : 'off';
  return `${e.padEnd(30)} ${sections.join(', ').padEnd(32)} digest: ${d}`;
});
console.log(rows.length ? rows.join('\n') : '(nobody)');

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

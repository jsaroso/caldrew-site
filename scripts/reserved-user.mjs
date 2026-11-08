#!/usr/bin/env node
// Manage who can open which part of the reserved area.
//   node scripts/reserved-user.mjs set name@example.com press dealflow   (replaces their sections)
//   node scripts/reserved-user.mjs add name@example.com fundraising      (adds sections)
//   node scripts/reserved-user.mjs revoke name@example.com dealflow      (removes sections)
//   node scripts/reserved-user.mjs remove name@example.com               (removes the person)
//   node scripts/reserved-user.mjs list
// Sections: press, fundraising, dealflow.
// Then commit reserved-users.json; the site redeploys and changes apply immediately.
import fs from 'node:fs';

const SECTIONS = ['press', 'fundraising', 'dealflow'];
const FILE = new URL('../reserved-users.json', import.meta.url);
const [cmd, raw, ...rest] = process.argv.slice(2);
const email = (raw || '').trim().toLowerCase();
const users = JSON.parse(fs.readFileSync(FILE, 'utf8'));

const bad = rest.filter((s) => !SECTIONS.includes(s));
if (bad.length) fail(`unknown section: ${bad.join(', ')} (use ${SECTIONS.join(', ')})`);
if (['set', 'add', 'revoke', 'remove'].includes(cmd) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('give an email address');

const order = (list) => SECTIONS.filter((s) => list.includes(s));
const current = users[email] || [];

if (cmd === 'set' && rest.length) users[email] = order(rest);
else if (cmd === 'add' && rest.length) users[email] = order([...current, ...rest]);
else if (cmd === 'revoke' && rest.length) users[email] = order(current.filter((s) => !rest.includes(s)));
else if (cmd === 'remove') delete users[email];
else if (cmd !== 'list') fail('usage: set|add|revoke <email> <sections...> | remove <email> | list');

for (const [e, s] of Object.entries(users)) if (!s.length) delete users[e];
if (cmd !== 'list') {
  const sorted = Object.fromEntries(Object.entries(users).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(FILE, JSON.stringify(sorted, null, 2) + '\n');
}
const rows = Object.entries(users);
console.log(rows.length ? rows.map(([e, s]) => `${e.padEnd(36)} ${s.join(', ')}`).join('\n') : '(nobody)');

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

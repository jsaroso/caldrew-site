#!/usr/bin/env node
// Manage who can open the private Press area.
//   node scripts/press-user.mjs add name@example.com
//   node scripts/press-user.mjs remove name@example.com   (ends their access immediately)
//   node scripts/press-user.mjs list
// Then commit press-users.json; the site redeploys automatically.
// People on the list sign in with their email: they receive a link and a 6-digit code.
import fs from 'node:fs';

const FILE = new URL('../press-users.json', import.meta.url);
const [cmd, raw] = process.argv.slice(2);
const email = (raw || '').trim().toLowerCase();
const users = new Set(JSON.parse(fs.readFileSync(FILE, 'utf8')));
const save = () => fs.writeFileSync(FILE, JSON.stringify([...users].sort(), null, 2) + '\n');

if (cmd === 'add' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  users.add(email);
  save();
  console.log(`added ${email}`);
} else if (cmd === 'remove' && email) {
  users.delete(email);
  save();
  console.log(`removed ${email}`);
} else if (cmd === 'list') {
  console.log([...users].join('\n') || '(nobody)');
} else {
  console.log('usage: node scripts/press-user.mjs add|remove <email> | list');
  process.exit(1);
}

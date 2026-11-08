#!/usr/bin/env node
// Manage who can open the private Press area.
//   node scripts/press-user.mjs add name@example.com     -> creates a password, prints it once
//   node scripts/press-user.mjs remove name@example.com  -> removes access (ends their session too)
//   node scripts/press-user.mjs list
// Then commit press-users.json; the site redeploys automatically.
import { webcrypto as crypto } from 'node:crypto';
import fs from 'node:fs';

const FILE = new URL('../press-users.json', import.meta.url);
const ITERATIONS = 100000; // Cloudflare Workers' PBKDF2 maximum
const [cmd, rawEmail] = process.argv.slice(2);
const users = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const email = (rawEmail || '').trim().toLowerCase();
const b64 = (b) => Buffer.from(b).toString('base64url');

// 20 characters from an unambiguous alphabet, in groups of four: about 100 bits.
function newPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const out = [];
  while (out.length < 20) {
    const [b] = crypto.getRandomValues(new Uint8Array(1));
    if (b < 248) out.push(alphabet[b % alphabet.length]); // 248 = 8 * 31, avoids modulo bias
  }
  return out.join('').match(/.{4}/g).join('-');
}

async function hash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256);
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

const save = () =>
  fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(Object.entries(users).sort()), null, 2) + '\n');

if (cmd === 'add' && email.includes('@')) {
  const password = newPassword();
  users[email] = await hash(password);
  save();
  console.log(`${email}\n${password}`);
} else if (cmd === 'remove' && email) {
  delete users[email];
  save();
  console.log(`removed ${email}`);
} else if (cmd === 'list') {
  console.log(Object.keys(users).join('\n') || '(nobody)');
} else {
  console.log('usage: node scripts/press-user.mjs add|remove <email> | list');
  process.exit(1);
}

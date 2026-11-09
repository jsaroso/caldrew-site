# caldrew.com

The Caldrew website: Astro (static) served by a Cloudflare Worker.
Migrated from Webflow in November 2026; design and copy are unchanged.

## Structure

| Path | What it is |
|---|---|
| `src/pages/*.astro`, `src/pages/pt/*.astro` | One file per page, English and Portuguese |
| `src/layouts/Base.astro` | `<head>`, SEO tags, hreflang, nav and footer |
| `src/i18n.js` | Nav and footer labels for both languages |
| `public/css/caldrew.css` | The original Webflow stylesheet, kept as-is |
| `src/styles/overrides.css` | Small additions on top of it |
| `public/js/site.js` | Language dropdown and contact form (replaces webflow.js) |
| `public/images/` | Portraits and logos |
| `worker/index.js` | Contact form email + Press access check |
| `wrangler.jsonc` | Cloudflare config |

## Day to day

```bash
npm install
npm run dev        # http://localhost:4321, live reload, no Worker
npm run preview    # build + run on Cloudflare's runtime (Worker, form, redirects)
npm run deploy     # build + deploy to Cloudflare
```

With the GitHub integration (Workers Builds) connected, merging to `main` deploys
automatically and every pull request gets a preview URL.

## Contact form

`POST /api/contact` emails `enquiries@caldrew.com` through Cloudflare's
`send_email` binding, with Reply-To set to the sender. Spam protection: a honeypot
field, server-side validation, and optionally Cloudflare Turnstile.

Requirements (one-time, Cloudflare dashboard):

1. **Email Routing on `notify.caldrew.com`** (a subdomain, so the MX records of
   `caldrew.com` and the existing mailbox are untouched).
   Email > Email Routing > Settings > Subdomains > add `notify`.
2. **Verify `enquiries@caldrew.com` as a destination address**
   (Email Routing > Destination addresses). Click the link in the confirmation email.

**Never enable Email Routing for caldrew.com itself.** Mail for caldrew.com is hosted on
Google Workspace. Cloudflare's Email Routing page shows caldrew.com as "misconfigured";
that is expected. Clicking "Add records" or "Fix" there would replace the Google MX records
and break every caldrew.com mailbox.

Optional Turnstile:

1. Turnstile > Add widget for `www.caldrew.com` and `caldrew.com`.
2. Set the site key at build time: `PUBLIC_TURNSTILE_SITE_KEY` (Workers Builds > Variables).
3. Set the secret on the Worker: `npx wrangler secret put TURNSTILE_SECRET`.

## Reserved area

`/reserved` (and `/pt/reserved`) is private. Each person has access to one or more sections:

| Section | URL | Content |
|---|---|---|
| Press | `/reserved/press` | Press kit (`src/pages/reserved/press.astro`) |
| Fundraising | `/reserved/fundraising` | `src/pages/reserved/fundraising.astro` |
| Dealflow | `/reserved/dealflow` | `src/pages/reserved/dealflow.astro` |

How it works (`worker/reserved.js`):

- Sign-in is email only: the visitor enters their email; if it is on the list they receive an email
  with a sign-in link and a 6-digit code (either works, for 15 minutes). The page answers the same
  way for every address, so it never reveals who has access.
- After signing in, visitors return to the page they asked for. The hub and the bar at the top only
  show the sections that person may open; any other section shows a "no access" page.
- Permissions are read on every request: changes apply immediately, even mid-session.
- Sessions last 30 days (signed cookie, `PRESS_SESSION_SECRET`).
- Protected downloads go in `public/reserved/files/<section>/` and are linked as
  `/reserved/files/<section>/<file>`. They need the same permission as the section.
- Every sign-in, page view, download and refused access is logged with the email and time
  (Cloudflare > Workers > caldrew-site > Logs; filter on `reserved`).
- Old `/press` links redirect to `/reserved/press`.
- While someone is signed in, the reserved-area bar also appears on the public pages (under the
  main navigation), so they can get back in one click. Signed-out visitors never see it. Pages
  with the bar are never cached.
- Limits: 10 attempts per minute per IP; 3 emails per minute per address.

Managing access (`reserved-users.json`):

```bash
node scripts/reserved-user.mjs set name@example.com press dealflow   # replaces their sections
node scripts/reserved-user.mjs add name@example.com fundraising      # adds sections
node scripts/reserved-user.mjs revoke name@example.com dealflow      # removes sections
node scripts/reserved-user.mjs remove name@example.com               # removes the person
node scripts/reserved-user.mjs digest name@example.com fundraising   # daily digest for these sections only
node scripts/reserved-user.mjs digest name@example.com off           # no digest emails
node scripts/reserved-user.mjs digest name@example.com all           # digest for all their sections (default)
node scripts/reserved-user.mjs list
```

Commit `reserved-users.json` and push; the site redeploys.

**Weekly summaries** (Mondays 07:00 UTC, only when something changed): each person chooses which
summaries they receive at `/reserved/settings` ("Email updates" in the reserved bar; also linked from
every summary). Their choice is stored in KV and wins over the default; the default is the `digest`
setting in `reserved-users.json`, or all their sections if it is not set. Staging keeps separate
preferences.

### Fundraising: synced from Google Sheets

The Fundraising section shows the **Owners** tab of the "CCFI - LP Target List" spreadsheet.
The sheet publishes itself; nobody copies data by hand.

- `scripts/apps-script/reserved-sync.gs` lives in the spreadsheet (Extensions > Apps Script).
  It sends the tab to `POST /api/sync/fundraising` every 15 minutes, and on demand from the
  sheet's **Caldrew > Publish to website now** menu. It only sends when something changed.
  `@OnlyCurrentDoc` limits it to that one spreadsheet.
- It authenticates with `SYNC_SECRET` (Worker secret; the same value is stored in the script's
  properties via **Caldrew > Set up automatic publishing**). To rotate: set a new Worker secret,
  then run the setup menu again with the new key.
- The Worker keeps the latest version in Workers KV (`RESERVED_KV`) and renders it on every
  request, so the page is always current and the data is never a public file.
- Changes (new or removed rows, Stage and First contact updates) are logged. Every Monday at
  07:00 UTC everyone following Fundraising receives a weekly summary, only if something changed.
- The page layout (which columns show, filters) is set in `src/pages/reserved/fundraising.astro`.
  New columns in the sheet appear automatically in the expanded row.

### Dealflow: synced from Google Sheets

The Dealflow section shows the "Caldrew - Deal Flow Pipeline" spreadsheet: the **Pipeline** tab,
plus **Activity Log**, **Questions & Decisions** and **Lists**. Same mechanism as Fundraising:
`scripts/apps-script/dealflow-sync.gs` in that spreadsheet publishes to `POST /api/sync/dealflow`,
with its own key (`SYNC_SECRET_DEALFLOW`). Rows are matched on the ID column; the daily digest
reports changes to stage, status, ball with and next step, named by opportunity.

**Deal documents.** The same script uploads the files in the Drive folder "Investment
Opportunities" (Drive id in `CONFIG.docs.folderId`) to the deals they belong to, every hour and
from the Caldrew menu ("Publish documents now"). The **Documents** tab of the spreadsheet says
which Drive folder or file goes to which deal: `Drive path | Deal ID | Notes`. The most specific
path wins, a Deal ID can list several deals (`CD-040, CD-041`), and `-` leaves a path off the
website. New folders nobody has matched yet are added to the tab with an empty Deal ID and a
yellow fill. Code files, shortcuts and pipeline snapshots are skipped; files over 25 MB are not
uploaded.

- Website side: `worker/docs.js`. Files are stored in KV (`doc:dealflow:<driveId>`, list in
  `docs:dealflow`); only new or changed files are uploaded, and files removed from Drive (or
  moved to `-`) are deleted from the website on the next run.
- Visitors download from `/reserved/files/dealflow/<driveId>`, with the same permission as the
  Dealflow section. Every download is logged with the person's email and the file name.
- The script needs read-only Drive access: `scripts/apps-script/appsscript.json` is its manifest
  (Project Settings > Show "appsscript.json" manifest file in editor).

### Sending the sign-in emails

Reserved-area sign-in emails are sent through **Cloudflare Email Sending** (Workers Paid plan) from `noreply@notify.caldrew.com`,
with replies going to enquiries@caldrew.com. The `PRESS_EMAIL` binding may only send from that
address. `notify.caldrew.com` has its own DKIM key and a DMARC `reject` policy. No personal
mailbox or third-party account is involved.

Worker secrets (Cloudflare > Workers > caldrew-site > Settings > Variables and Secrets, type
"Secret"; the same on caldrew-site-staging): `PRESS_SESSION_SECRET` and `SYNC_SECRET`,
each any long random string.

Local development: emails are written to `.wrangler/tmp/email/` instead of being sent.

## Staging (next.caldrew.com)

Separate Worker `caldrew-site-staging`, deployed automatically from the `staging` branch
(`npx wrangler deploy --env staging`). Workflow: changes go to `staging`, are reviewed on
next.caldrew.com, then merged to `main` for www.caldrew.com.

- Every page requires sign-in with the same Caldrew sign-in page and email as the reserved area,
  worded as a preview. Who can sign in: `staging-users.json`.
- Staging reads the live reserved-area data but cannot change it (no `SYNC_SECRET`, no digests).
- Never indexed (`X-Robots-Tag: noindex`). Contact form emails are prefixed "[Staging]".

## Domains (cutover from Webflow: 8 November 2026)

`caldrew.com` and `www.caldrew.com` are **Workers Custom Domains** on `caldrew-site`
(set in `wrangler.jsonc`; Cloudflare manages their DNS records and certificates).
`caldrew.com` redirects to `www.caldrew.com`. Staging is `next.caldrew.com`.

Cleaned up at cutover: the Webflow CNAME/A records, the `_webflow` verification record and
GoDaddy's `_domainconnect` record. Email records (Google MX, SPF, DKIM, DMARC) and
`notify.caldrew.com` were not touched by the cutover.

Note: while the domains are still connected to a Webflow project, Webflow can claim traffic for
them. Remove caldrew.com and www.caldrew.com from the Webflow site settings before cancelling.

Emergency rollback to Webflow (only while the Webflow site still exists): remove the two custom
domains (Workers > caldrew-site > Settings > Domains & Routes), then recreate
`www  CNAME cdn.webflow.com` and `caldrew.com  A 198.202.211.1`, both proxied.

## Differences from the Webflow version

- Fonts are self-hosted (no Google Fonts requests, so no visitor IPs sent to Google).
- Webflow's jQuery and unused custom scripts are gone; the page weight drops accordingly.
- Fixed: the Portuguese Press page showed the Team page header and was mostly in English.
- Fixed: footer Terms and Cookie Policy links now jump to their sections.
- Fixed: the press contact email link was missing `mailto:`.
- Portraits now have alt text; the language toggle is a real button (keyboard accessible).
- `/401` (Webflow's password page) redirects to the homepage.

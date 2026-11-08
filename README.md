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

## Press (private area)

`/press` and `/pt/press` are private. Visitors who are not signed in see a branded sign-in page
(`src/components/PressGate.astro`, same layout as the old Webflow login page). They enter their
email; if it is on the list, they receive an email with a sign-in link and a 6-digit code
(either works, for 15 minutes). The page answers the same way for every address, so it never
reveals who has access. Logic: `worker/press.js`.

- The list is `press-users.json`. Removing someone ends their access immediately, even mid-session.
- Sessions last 30 days (signed cookie, `PRESS_SESSION_SECRET`).
- Links can be opened more than once within 15 minutes, because corporate mail scanners
  (Outlook, Mimecast) open links before people do.
- Limits: 10 attempts per minute per IP; 3 emails per minute per address.

```bash
node scripts/press-user.mjs add name@example.com
node scripts/press-user.mjs remove name@example.com
node scripts/press-user.mjs list
```

Commit `press-users.json` and push; the site redeploys.

### Sending the sign-in emails

Sent through **Cloudflare Email Sending** (Workers Paid plan) from `noreply@notify.caldrew.com`,
with replies going to enquiries@caldrew.com. The `PRESS_EMAIL` binding may only send from that
address. `notify.caldrew.com` has its own DKIM key and a DMARC `reject` policy. No personal
mailbox or third-party account is involved.

Worker secret (Cloudflare > Workers > caldrew-site > Settings > Variables and Secrets, type
"Secret"; the same on caldrew-site-staging): `PRESS_SESSION_SECRET`, any long random string.

Local development: emails are written to `.wrangler/tmp/email/` instead of being sent.

## Staging (next.caldrew.com)

Separate Worker `caldrew-site-staging`, deployed from the `staging` branch with
`npx wrangler deploy --env staging`. The whole of next.caldrew.com is behind the Cloudflare
Access application "Caldrew Staging" (email one-time code), so drafts stay private and are
never indexed. Add reviewers in Zero Trust > Access > Applications > Caldrew Staging > Policies.
Contact form emails sent from staging are prefixed "[Staging]".

## Cutover from Webflow

1. Deploy and check the `*.workers.dev` URL against the live site.
2. Complete the contact form and Access steps above; send a test enquiry.
3. Workers > caldrew-site > Settings > Domains & Routes > Add custom domain:
   `www.caldrew.com` and `caldrew.com`. Cloudflare replaces the Webflow DNS records.
   (Or uncomment `routes` in `wrangler.jsonc` and deploy.)
4. Rules > Redirect Rules: `caldrew.com/*` -> `https://www.caldrew.com/${1}` (301), as Webflow did.
5. Keep the Webflow site plan for about two weeks as a fallback, then cancel.

Rollback: remove the custom domains and restore the previous DNS records for Webflow.

## Differences from the Webflow version

- Fonts are self-hosted (no Google Fonts requests, so no visitor IPs sent to Google).
- Webflow's jQuery and unused custom scripts are gone; the page weight drops accordingly.
- Fixed: the Portuguese Press page showed the Team page header and was mostly in English.
- Fixed: footer Terms and Cookie Policy links now jump to their sections.
- Fixed: the press contact email link was missing `mailto:`.
- Portraits now have alt text; the language toggle is a real button (keyboard accessible).
- `/401` (Webflow's password page) redirects to the homepage.

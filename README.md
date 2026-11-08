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

`/press` and `/pt/press` are private. Visitors who are not signed in see a branded sign-in
page (`src/components/PressGate.astro`, same layout as the old Webflow login page) with a
"Continue with email" button and a "Request access" link.

The button goes to `/press/signin`, which is protected by **Cloudflare Access** (Zero Trust,
free up to 50 users). Access asks for the visitor's email and sends a one-time code; there is no
password to share. After that, the Worker stores the Access token in a cookie and opens
`/press` for the rest of the Access session. Every token is verified against Cloudflare's
public keys, and if Access is not configured nobody gets in.

Setup (one-time):

1. Zero Trust > Access > Applications > Add an application > Self-hosted.
   - Name: Caldrew Press. Session duration: 24 hours (or longer).
   - Public hostnames: `www.caldrew.com` path `press/signin`, `caldrew.com` path `press/signin`
     (plus any staging hostname, e.g. `next.caldrew.com` path `press/signin`).
   - Policy: Allow > Include > Emails: the people who should have access.
   - Login methods: One-time PIN.
2. From the application's overview, copy the **Application Audience (AUD) tag**, and from
   Zero Trust > Settings > Team name and domain, the **team domain** (`<team>.cloudflareaccess.com`).
   Put them in `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` in `wrangler.jsonc` and deploy.
3. Optional branding of the code screen: Zero Trust > Settings > Custom pages > Login page
   (logo `public/images/caldrew-logo.png`, background `#F7F4EE`, header "Caldrew").

To give someone access: add their email to the policy. To revoke: remove it (takes effect when
their current session expires). Sign out: `/press/signout`.

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

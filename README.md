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

Optional Turnstile:

1. Turnstile > Add widget for `www.caldrew.com` and `caldrew.com`.
2. Set the site key at build time: `PUBLIC_TURNSTILE_SITE_KEY` (Workers Builds > Variables).
3. Set the secret on the Worker: `npx wrangler secret put TURNSTILE_SECRET`.

## Press (private area)

`/press` and `/pt/press` are protected by **Cloudflare Access** (Zero Trust, free up to 50 users).
People listed in the policy get a one-time code by email; nobody shares a password.

1. Zero Trust > Access > Applications > Add > Self-hosted.
   - Domains: `www.caldrew.com/press`, `www.caldrew.com/pt/press`, and the same for `caldrew.com`.
   - Policy: Allow, Include > Emails (or Emails ending in, for a whole firm).
   - Login method: One-time PIN.
2. Copy the application's **AUD tag** and your **team domain** (`<team>.cloudflareaccess.com`)
   into `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` in `wrangler.jsonc`, then deploy.

The Worker also verifies the Access token itself and **fails closed**: if Access is not
configured, or a request reaches the Worker another way (workers.dev, preview URLs),
Press returns 403. To view Press on preview URLs, enable Access for `workers.dev`
under Workers > caldrew-site > Settings > Domains & Routes.

To give someone access: add their email to the Access policy. To revoke: remove it.

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

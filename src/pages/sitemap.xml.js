// Public pages only. Press is private and 404 is excluded.
const slugs = ['', 'approach', 'team', 'contact', 'legal'];
const site = 'https://www.caldrew.com';

export function GET() {
  const url = (slug) => {
    const en = `${site}/${slug}`.replace(/\/$/, '') || site;
    const pt = `${site}/pt${slug ? '/' + slug : ''}`;
    const enLoc = slug ? en : `${site}/`;
    const alts = `<xhtml:link rel="alternate" hreflang="en" href="${enLoc}"/><xhtml:link rel="alternate" hreflang="pt-PT" href="${pt}"/>`;
    return `<url><loc>${enLoc}</loc>${alts}</url><url><loc>${pt}</loc>${alts}</url>`;
  };
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${slugs.map(url).join('')}</urlset>\n`;
  return new Response(body, { headers: { 'Content-Type': 'application/xml' } });
}

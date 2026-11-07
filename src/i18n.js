// Shared navigation and footer copy for both locales.
export const t = {
  en: {
    home: '/',
    nav: [
      ['approach', 'Approach'],
      ['team', 'Team'],
      ['contact', 'Contact'],
    ],
    legal: [
      ['privacy', 'Privacy Policy'],
      ['terms', 'Terms'],
      ['cookies', 'Cookie Policy'],
    ],
    registered: 'Caldrew, S.A. · Registered office: Rua Castilho 32 - 4, 1250-070 Lisboa, Portugal',
    disclaimer: 'This website is for information only and does not constitute an offer or solicitation of any kind.',
  },
  pt: {
    home: '/pt',
    nav: [
      ['approach', 'Abordagem'],
      ['team', 'Equipa'],
      ['contact', 'Contacto'],
    ],
    legal: [
      ['privacy', 'Política de Privacidade'],
      ['terms', 'Termos'],
      ['cookies', 'Política de Cookies'],
    ],
    registered: 'Caldrew, S.A. · Sede social: Rua Castilho 32 - 4, 1250-070 Lisboa, Portugal',
    disclaimer: 'Este website tem fins meramente informativos e não constitui qualquer oferta ou solicitação.',
  },
};

// "/pt/team" -> "team", "/" -> ""
export function slugOf(pathname) {
  return pathname
    .replace(/\.html$/, '')
    .replace(/(^|\/)index$/, '')
    .replace(/^\/pt(?=\/|$)/, '')
    .replace(/^\/|\/$/g, '');
}

export function localePath(lang, slug) {
  if (lang === 'pt') return slug ? `/pt/${slug}` : '/pt';
  return slug ? `/${slug}` : '/';
}

import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://www.caldrew.com',
  output: 'static',
  trailingSlash: 'never',
  // press.astro -> press.html, so URLs stay /press (as on Webflow), not /press/
  build: { format: 'file' },
});

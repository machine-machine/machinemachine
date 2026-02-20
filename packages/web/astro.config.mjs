import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';

export default defineConfig({
  output: 'static',
  integrations: [mdx()],
  build: {
    assets: '_assets'
  },
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'de', 'pl'],
    routing: {
      prefixDefaultLocale: false
    }
  }
});

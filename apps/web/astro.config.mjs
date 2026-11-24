// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  // The canonical origin, and the ONLY place it is written down. Absolute URLs are
  // required for Open Graph tags, and robots.txt / sitemap.xml are generated from
  // this rather than hand-written, so there is nothing to drift.
  //
  // CHANGE THIS ONE LINE when lotus.build is registered and attached — see
  // plans/lotus-web/issues/09.
  site: 'https://lotus-web.pages.dev',

  build: {
    // Astro inlines a small hoisted `<script>` straight into the page, and this site's CSP
    // is `script-src 'self'` with no hash and no nonce — so the browser blocked the one
    // script we have and the canvas nodes silently stopped being draggable. Nothing in the
    // build failed; it only showed up as a CSP violation in the console.
    //
    // `assetsInlineLimit: 0` below forces every asset out to a file, and this forces the
    // script with it. Keep both: relaxing the CSP instead would buy an inline-script
    // allowance for the whole site to save one request.
    inlineStylesheets: 'never'
  },

  vite: {
    plugins: [tailwindcss()],
    build: {
      // See the note above — 0 means "never inline", which is what the CSP requires.
      assetsInlineLimit: 0
    }
  }
});

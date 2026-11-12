import { defineConfig, loadEnv } from 'vite';

// Relative paths let the built game run from any folder or host.
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env };
  const domain = env.VITE_PLAUSIBLE_DOMAIN;
  return {
    base: './',
    plugins: [{
      name: 'palisade-analytics',
      // Only a build that names a Plausible domain loads the analytics script.
      transformIndexHtml: (html) => (domain
        ? html.replace('</head>', `<script defer data-domain="${domain}" src="https://plausible.io/js/script.js"></script>\n</head>`)
        : html),
    }],
  };
});

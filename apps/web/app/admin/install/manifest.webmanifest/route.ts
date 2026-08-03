// PWA manifest for the installer, scoped to /admin/install so installing it
// puts the capture screen on the home screen and nothing else.
export function GET(): Response {
  const manifest = {
    name: 'Overwatch Tally — install',
    short_name: 'OT Install',
    description: 'Capture sensor installs at the pen, with or without signal.',
    start_url: '/admin/install',
    scope: '/admin/install/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0b0e12',
    theme_color: '#16233f',
    icons: [
      {
        src: '/admin/install/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: '/admin/install/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'maskable',
      },
    ],
  };

  return new Response(JSON.stringify(manifest), {
    headers: {
      'Content-Type': 'application/manifest+json',
      'Cache-Control': 'no-cache',
    },
  });
}

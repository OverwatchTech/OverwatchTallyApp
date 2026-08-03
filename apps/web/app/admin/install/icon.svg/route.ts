// Home-screen icon. Drawn rather than shipped as a binary so the installer app
// carries no asset that has to be kept in step with the design tokens.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#16233F"/>
  <circle cx="256" cy="256" r="112" fill="none" stroke="#2DD4A7" stroke-width="24"/>
  <circle cx="256" cy="256" r="32" fill="#2DD4A7"/>
  <path d="M256 64v48M256 400v48M64 256h48M400 256h48" stroke="#F7F8F5" stroke-width="24" stroke-linecap="round"/>
</svg>`;

export function GET(): Response {
  return new Response(SVG, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

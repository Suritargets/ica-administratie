import type { NextConfig } from 'next';

const config: NextConfig = {
  poweredByHeader: false,
  outputFileTracingIncludes: { '/app': ['./src/spa/**/*', './src/brand/**/*'] },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'same-origin' },
        { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
      ],
    }];
  },
};
export default config;

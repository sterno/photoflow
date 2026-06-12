import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle so the Docker runner stage doesn't
  // need the full node_modules tree to start the app.
  output: 'standalone',
  // ffmpeg-static ships a platform-specific binary that Webpack can't bundle
  // sensibly. Mark it external so Next leaves it in node_modules at runtime,
  // and the standalone tracer will still copy the package (and its binary)
  // into the runner image.
  serverExternalPackages: ['ffmpeg-static'],
  experimental: {
    // Photo uploads (especially RAW formats) routinely exceed Next.js's default 10MB
    // proxy body cap. Above the cap the body is silently truncated and the route
    // handler fails to parse FormData. Raise to 200MB to comfortably accommodate
    // typical photo and short-video uploads.
    proxyClientMaxBodySize: '200mb',
  },
  // Baseline security headers applied to every response. These matter more for
  // an OSS release (many third-party deployments) than they would for a single
  // known deployment. The CSP keeps 'unsafe-inline'/'unsafe-eval' because Next's
  // runtime and React Bootstrap rely on inline styles/scripts; tightening to a
  // nonce-based policy is a worthwhile follow-up. img-src/media-src allow https:
  // so presigned S3 URLs (whose host varies by bucket/region) load without
  // hardcoding a bucket origin.
  async headers() {
    const csp = [
      "default-src 'self'",
      "img-src 'self' https: data: blob:",
      "media-src 'self' https: data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "font-src 'self' data:",
      "connect-src 'self' https:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; ');
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains',
          },
        ],
      },
    ];
  },
};

export default nextConfig;

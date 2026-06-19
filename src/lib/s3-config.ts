// S3Client configuration shared by the app (s3.ts) and scripts/setup.ts.
//
// With no custom endpoint configured this is plain AWS S3. Setting
// S3_ENDPOINT (or AWS_ENDPOINT_URL_S3) targets any S3-compatible store —
// MinIO, Cloudflare R2, Backblaze B2 — with the compatibility tweaks those
// need:
//  - path-style addressing (MinIO has no per-bucket DNS); disable with
//    S3_FORCE_PATH_STYLE=false for stores that prefer virtual-hosted style
//  - checksums only when required: the AWS SDK defaults to sending CRC32
//    flexible checksums on uploads, which B2 and older MinIO reject
//
// Presigned URLs embed the endpoint host and are fetched by BROWSERS (gallery
// <img> tags, download links), so when the server reaches the store over a
// private network (e.g. a compose service hostname) set S3_PUBLIC_ENDPOINT to
// the browser-reachable URL — presigning uses it, server-side ops keep using
// S3_ENDPOINT.
//
// NOTE: imported by scripts/setup.ts under tsx, outside Next — keep this file
// free of 'server-only' and path-alias imports.

import type { S3ClientConfig } from '@aws-sdk/client-s3';

function customEndpoint(forPresigning: boolean): string | undefined {
  const internal = process.env.S3_ENDPOINT || process.env.AWS_ENDPOINT_URL_S3;
  if (forPresigning) return process.env.S3_PUBLIC_ENDPOINT || internal;
  return internal;
}

/** Config for the given purpose; presigning may use a different endpoint. */
export function buildS3ClientConfig(opts?: { forPresigning?: boolean }): S3ClientConfig {
  const endpoint = customEndpoint(opts?.forPresigning ?? false);
  return {
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    },
    ...(endpoint
      ? {
          endpoint,
          forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
          requestChecksumCalculation: 'WHEN_REQUIRED' as const,
          responseChecksumValidation: 'WHEN_REQUIRED' as const,
        }
      : {}),
  };
}

/** True when presigned URLs must be signed against a different host. */
export function hasDistinctPublicEndpoint(): boolean {
  return Boolean(
    process.env.S3_PUBLIC_ENDPOINT &&
      process.env.S3_PUBLIC_ENDPOINT !== customEndpoint(false),
  );
}

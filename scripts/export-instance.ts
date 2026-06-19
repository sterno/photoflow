/**
 * CLI: export one client's full data as a portable bundle ZIP, to be imported
 * into a multi-client PhotoFlow instance as a new client.
 *
 *   npm run export:instance -- --client <slug|id> --out ./bundle.zip
 *
 * Defaults: --client default-client (the client a freshly-upgraded standalone
 * instance puts all its data under), --out ./photoflow-bundle-<slug>.zip.
 *
 * Run this on the SOURCE instance (must be on PhotoFlow 1.1+; a pre-1.1
 * standalone should run the in-place migration first, which creates
 * 'default-client').
 */
import 'dotenv/config';
import { createWriteStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { prisma } from '@/lib/prisma';
import { buildS3ClientConfig } from '@/lib/s3-config';
import { exportClientBundle } from '@/server/migrate/exportBundle';

// The CLI builds its own S3 client rather than importing @/lib/s3 (which is
// marked `server-only` and won't resolve outside the Next bundler).
const s3 = new S3Client(buildS3ClientConfig());
const bucket = process.env.AWS_S3_BUCKET || 'photoflow-media';
async function getObjectStream(key: string): Promise<Readable> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`No body for ${key}`);
  return res.Body as Readable;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      out[key] = val;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ref = args.client || 'default-client';

  const client = await prisma.client.findFirst({
    where: { OR: [{ id: ref }, { slug: ref }] },
    select: { id: true, name: true, slug: true },
  });
  if (!client) {
    console.error(`No client matching "${ref}" (by id or slug). Available:`);
    const all = await prisma.client.findMany({ select: { slug: true, name: true } });
    for (const c of all) console.error(`  - ${c.slug} (${c.name})`);
    process.exit(1);
  }

  const outPath = args.out || `./photoflow-bundle-${client.slug}.zip`;
  console.log(`Exporting client "${client.name}" (${client.slug}) → ${outPath} ...`);

  const output = createWriteStream(outPath);
  const result = await exportClientBundle(client.id, output, { getObjectStream });

  console.log(`Done: ${result.events} event(s), ${result.media} media item(s) written to ${outPath}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

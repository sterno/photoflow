import 'dotenv/config';
import { S3Client, HeadBucketCommand, CreateBucketCommand } from '@aws-sdk/client-s3';
import { createDbAdapter } from '../src/lib/db-adapter';
import { buildS3ClientConfig } from '../src/lib/s3-config';
import { PrismaClient, UserRole } from '../src/generated/prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient({ adapter: createDbAdapter() });

/**
 * Create the media bucket if it doesn't exist — only when a custom
 * S3-compatible endpoint is configured (MinIO in Docker Compose / Railway).
 * Never auto-create on real AWS: a typo'd bucket name there should fail
 * loudly, not silently create a bucket in the wrong account/region.
 */
async function ensureBucket(): Promise<void> {
  if (!process.env.S3_ENDPOINT && !process.env.AWS_ENDPOINT_URL_S3) return;
  const bucket = process.env.AWS_S3_BUCKET || 'photoflow-media';
  const s3 = new S3Client(buildS3ClientConfig());
  try {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
      console.log(`Bucket "${bucket}" already exists`);
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      console.log(`Created bucket "${bucket}"`);
    }
  } finally {
    s3.destroy();
  }
}

/**
 * Read a required env var or fail with a clear message. We refuse to seed a
 * default admin without explicit credentials — shipping a known password
 * (`admin / admin123`) in the repo was a footgun for anyone who pushed
 * PhotoFlow public without changing it.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    console.error(
      `\nMissing required environment variable: ${name}\n\n` +
        `Setup needs admin credentials to seed the first user. Set both\n` +
        `ADMIN_USERNAME and ADMIN_PASSWORD in your environment (or .env)\n` +
        `before running this script. Example:\n\n` +
        `  ADMIN_USERNAME=admin ADMIN_PASSWORD='choose-something-strong' npm run setup\n`,
    );
    process.exit(1);
  }
  return value;
}

async function main() {
  console.log('Setting up PhotoFlow database...');

  // Cheap and idempotent — safe to run every boot, also covers a later
  // switch to a different S3-compatible endpoint.
  await ensureBucket();

  // The entrypoint runs this script on every container boot. Once an admin
  // exists the instance is considered initialized — bail before touching
  // anything else, or the systemConfig upserts below would clobber settings
  // the admin has since customized.
  const adminCount = await prisma.user.count({ where: { role: UserRole.ADMIN } });
  if (adminCount > 0) {
    console.log('Admin user already exists — skipping bootstrap.');
    return;
  }

  const adminUsername = requireEnv('ADMIN_USERNAME');
  const adminPassword = requireEnv('ADMIN_PASSWORD');
  if (adminPassword.length < 12) {
    console.error(
      '\nADMIN_PASSWORD must be at least 12 characters. Refusing to seed a weak admin.\n',
    );
    process.exit(1);
  }

  const hashedPassword = await bcrypt.hash(adminPassword, 12);

  const admin = await prisma.user.upsert({
    where: { username: adminUsername },
    update: {},
    create: {
      username: adminUsername,
      password: hashedPassword,
      role: UserRole.ADMIN,
    },
  });

  console.log('Created admin user:', admin.username);

  // A Client must exist before any Event (Event.clientId is required). Seed a
  // single default client that owns the default event; the bootstrap admin is a
  // global super-admin (implicit access everywhere) but also gets a CLIENT_ADMIN
  // membership so the default client shows up in the membership UI.
  const client = await prisma.client.upsert({
    where: { id: 'default-client' },
    update: {},
    create: {
      id: 'default-client',
      name: 'Default Client',
      slug: 'default',
    },
  });

  console.log('Created default client:', client.name);

  await prisma.clientMembership.upsert({
    where: { userId_clientId: { userId: admin.id, clientId: client.id } },
    update: {},
    create: { userId: admin.id, clientId: client.id, role: 'CLIENT_ADMIN' },
  });

  const event = await prisma.event.upsert({
    where: { id: 'default' },
    update: {},
    create: {
      id: 'default',
      name: 'Default Event',
      description: 'Default event for PhotoFlow',
      startDate: new Date(),
      isActive: true,
      clientId: client.id,
    },
  });

  console.log('Created default event:', event.name);

  const configs = [
    {
      key: 'image_sizes',
      value: [150, 800],
      description: 'Default image sizes to generate',
    },
    {
      key: 'watermark_settings',
      value: {
        enabled: false,
        text: 'PhotoFlow',
        position: 'bottom-right',
        opacity: 0.7,
      },
      description: 'Watermark configuration',
    },
    {
      key: 'file_naming_templates',
      value: [
        '{YYYY}_{MM}_{DD}_{photographer}_{sequence}.{ext}',
        '{event}_{photographer}_{YYYY}{MM}{DD}_{sequence}.{ext}',
      ],
      description: 'File naming templates',
    },
  ];

  for (const config of configs) {
    await prisma.systemConfig.upsert({
      where: { key: config.key },
      update: { value: config.value },
      create: config,
    });
  }

  console.log('Created system configurations');
  console.log('\nSetup complete!');
  console.log(`Sign in as: ${admin.username}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

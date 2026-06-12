import 'dotenv/config';
import { PrismaNeon } from '@prisma/adapter-neon';
import { PrismaClient, UserRole } from '../src/generated/prisma/client';
import bcrypt from 'bcryptjs';

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

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

  const event = await prisma.event.upsert({
    where: { id: 'default' },
    update: {},
    create: {
      id: 'default',
      name: 'Default Event',
      description: 'Default event for PhotoFlow',
      startDate: new Date(),
      isActive: true,
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

/**
 * Auth.js (NextAuth v5) configuration for PhotoFlow.
 * Username/password credentials only — single-team model, JWT sessions.
 * Exports the shared `auth` helper used by the proxy and server components,
 * plus the `handlers` mounted at /api/auth/[...nextauth].
 */
import NextAuth, { type DefaultSession } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import type { UserRole } from '@/generated/prisma/client';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      username: string;
      role: UserRole;
    } & DefaultSession['user'];
  }
  interface User {
    id?: string;
    username: string;
    role: UserRole;
  }
}

declare module '@auth/core/jwt' {
  interface JWT {
    userId: string;
    username: string;
    role: UserRole;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  // We're deployed behind a reverse proxy (Railway) where the incoming Host
  // header is the public hostname but Auth.js's default Vercel-only heuristic
  // doesn't recognize it. Trust whatever Host comes in — this is safe because
  // we control the deployment and the proxy strips/normalizes the header.
  trustHost: true,
  session: { strategy: 'jwt', maxAge: 60 * 60 * 24 * 7 },
  pages: { signIn: '/login' },
  providers: [
    Credentials({
      credentials: {
        username: { label: 'Username', type: 'text' },
        password: { label: 'Password', type: 'password' },
      },
      authorize: async (credentials) => {
        const username = credentials?.username as string | undefined;
        const password = credentials?.password as string | undefined;
        if (!username || !password) return null;

        const user = await prisma.user.findUnique({ where: { username } });
        if (!user) return null;

        const passwordMatches = await bcrypt.compare(password, user.password);
        if (!passwordMatches) return null;

        // PENDING users have valid credentials but haven't been approved by
        // an admin yet — surface a distinct error so the login page can show
        // a "waiting for approval" message instead of generic "bad password".
        if (user.role === 'PENDING') {
          throw new Error('PendingApproval');
        }

        return {
          id: user.id,
          username: user.username,
          role: user.role,
          name: user.username,
          email: user.email ?? undefined,
        };
      },
    }),
  ],
  callbacks: {
    jwt: async ({ token, user }) => {
      if (user) {
        token.userId = user.id as string;
        token.username = user.username;
        token.role = user.role;
      }
      return token;
    },
    session: async ({ session, token }) => {
      session.user.id = token.userId as string;
      session.user.username = token.username as string;
      session.user.role = token.role as UserRole;
      return session;
    },
  },
});

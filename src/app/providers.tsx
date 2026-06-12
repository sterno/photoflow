'use client';

// Client-side provider boundary mounted at the root. Exists so the
// server-rendered RootLayout (a server component) can still wrap children
// in SessionProvider, which must run on the client.
import { SessionProvider } from 'next-auth/react';
import type { ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}

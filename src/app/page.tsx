// Root route — PhotoFlow has no dedicated landing page for signed-in
// users, so '/' jumps straight to the live photo stream. Unauthenticated
// visitors get bounced to /login by middleware before this runs.
import { redirect } from 'next/navigation';

export default function Home() {
  redirect('/photos');
}

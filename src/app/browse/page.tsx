// Legacy /browse route preserved for old bookmarks and in-app links.
// The browsing UI moved to /photos; this just forwards there.
import { redirect } from 'next/navigation';

export default function BrowsePage() {
  redirect('/photos');
}

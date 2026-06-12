import { Gallery } from './Gallery';
import { PhotoDetail } from './PhotoDetail';
import { Collections, CollectionDetail } from './Collections';
import { getManifest } from './useManifest';
import { parseRoute, useHashRoute } from './useHashRoute';
import './styles.css';

export function App() {
  const hash = useHashRoute();
  const manifest = getManifest();

  if (!manifest) {
    return (
      <div className="app-shell error">
        <h1>Archive manifest missing</h1>
        <p>
          This archive viewer expects <code>manifest.js</code> alongside <code>index.html</code>.
          Make sure you opened the extracted folder, not just <code>index.html</code> moved out of
          it.
        </p>
      </div>
    );
  }

  const route = parseRoute(hash);

  // Top navigation only renders on the list/index routes; photo and
  // collection-detail views own their own back-link breadcrumbs.
  const showTopNav = route.name === 'gallery' || route.name === 'collections';

  return (
    <div className="app-shell">
      {showTopNav && (
        <nav className="top-nav">
          <a href="#/" className={`nav-link ${route.name === 'gallery' ? 'active' : ''}`}>
            Gallery
          </a>
          <a
            href="#/collections"
            className={`nav-link ${route.name === 'collections' ? 'active' : ''}`}
          >
            Collections{' '}
            <span className="nav-count">({manifest.collections.length})</span>
          </a>
          <div className="nav-spacer" />
          <span className="nav-event-name">{manifest.event.name}</span>
        </nav>
      )}

      {route.name === 'gallery' && <Gallery manifest={manifest} />}
      {route.name === 'photo' && <PhotoDetail manifest={manifest} photoId={route.photoId} />}
      {route.name === 'collections' && <Collections manifest={manifest} />}
      {route.name === 'collection' && (
        <CollectionDetail manifest={manifest} collectionId={route.collectionId} />
      )}
    </div>
  );
}

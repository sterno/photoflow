// Public marketing/orientation page describing what PhotoFlow is, how
// account approval works, and a high-level tour of the app. Rendered
// unauthenticated and linked from the login/signup flows.
import Link from 'next/link';

export const metadata = {
  title: 'About — PhotoFlow',
  description: 'What to expect when using PhotoFlow.',
};

export default function AboutPage() {
  return (
    <div className="bg-light text-dark min-vh-100">
      <header className="bg-dark text-white py-4">
        <div className="container">
          <h1 className="h2 mb-1">PhotoFlow</h1>
          <p className="mb-0 text-white-50">
            A shared workspace for photographers and a media team covering the same event.
          </p>
        </div>
      </header>

      <main className="container py-4 prose">
        <div className="row">
          <div className="col-lg-9">
            <section className="mb-5">
              <h2 className="h4 mb-3">What this is</h2>
              <p>
                PhotoFlow is the tool we use to move event photography from the photographers'
                cameras to the media team that posts and publishes. Photographers upload, the
                team filters/curates, and exports go out — all in one place, scoped to a single
                event at a time.
              </p>
              <p>
                It's invite-only. You won't be able to sign in until an admin assigns your
                account a role, but you can <Link href="/signup">request an account</Link> and the
                admins will be notified.
              </p>
            </section>

            <section className="mb-5">
              <h2 className="h4 mb-3">How accounts work</h2>
              <ol>
                <li>
                  You go to the <Link href="/signup">signup page</Link> and submit a username,
                  email, and password.
                </li>
                <li>
                  Your account is created in a <strong>pending</strong> state. You can't sign in
                  yet.
                </li>
                <li>
                  An admin sees your request, approves you, and assigns one of three roles:
                  <ul>
                    <li>
                      <strong>Subscriber</strong> — view photos, filter/search, build collections,
                      publish. Can't upload.
                    </li>
                    <li>
                      <strong>Publisher</strong> — everything a subscriber can do, plus upload
                      photos.
                    </li>
                    <li>
                      <strong>Admin</strong> — everything above, plus manage events, users, and
                      system settings.
                    </li>
                  </ul>
                </li>
                <li>You can now sign in and use the app.</li>
              </ol>
              <p>
                If you forget your password, the reset flow needs an email on your account.
                Set or update yours under your Profile after first login.
              </p>
            </section>

            <section className="mb-5">
              <h2 className="h4 mb-3">What you'll see when you sign in</h2>
              <p>
                The home page is the <strong>Photo Stream</strong>: a live grid of the most
                recent photos for whichever event is currently active. New uploads appear at the
                top within a couple of minutes. There's a filter bar above the grid for
                photographer, keyword, person name, shot type, and focal length.
              </p>
              <p>
                Across the top, you'll have navigation to:
              </p>
              <ul>
                <li><strong>Photo Stream</strong> — the live feed described above.</li>
                <li>
                  <strong>Browse</strong> — paginated view of all photos in the event, with the
                  same filters plus a date-of-event picker. Useful for looking back through the
                  shoot.
                </li>
                <li>
                  <strong>Collections</strong> — curated sets of photos. Shared across the team
                  — anyone can open one, anyone can add or remove.
                </li>
                <li>
                  <strong>Publishing</strong> — history of every export, who did it, and when.
                </li>
              </ul>
              <p>
                If your role is Publisher or Admin, there's also a toggle on the right side of
                the nav bar that switches between Subscriber Mode and Publisher Mode (the upload
                page).
              </p>
            </section>

            <section className="mb-5">
              <h2 className="h4 mb-3">A typical event flow</h2>
              <p>Here's roughly how a shoot day looks:</p>
              <ol>
                <li>
                  Before the event, an admin creates an event and marks it <em>active</em>. All
                  uploads will attach to it.
                </li>
                <li>
                  Photographers go to <strong>Publisher Mode</strong> and either drag photos in
                  as they edit them, or point PhotoFlow at a watched folder so anything they
                  export gets uploaded automatically.
                </li>
                <li>
                  Each upload is processed: EXIF metadata extracted (photographer, camera, time,
                  GPS), thumbnails generated, and an AI captioning pass that picks out shot type,
                  visible names on signs/tags, and a short description.
                </li>
                <li>
                  The media team watches the Photo Stream live. As photos roll in, they can
                  filter by criteria (e.g., "panel" shots, "Jane Smith" name tags) or build them
                  into collections.
                </li>
                <li>
                  When they need to publish — to a CMS, to social, to a folder for someone's
                  workflow — they open the collection, pick an output size and template, and
                  either download a ZIP or write the files directly to a folder on their machine.
                </li>
              </ol>
            </section>

            <section className="mb-5">
              <h2 className="h4 mb-3">A few specifics worth knowing</h2>
              <ul>
                <li>
                  <strong>Collections are shared.</strong> If you make a collection called
                  "Keynote selects" and someone else opens it later, they see what you put in it
                  and can add their own picks.
                </li>
                <li>
                  <strong>Smart collections</strong> are like saved searches. Set up filters that
                  describe what you want (e.g., shot type = "panel" + keyword = "AI track") and
                  save it as a smart collection. New uploads matching those filters appear
                  automatically.
                </li>
                <li>
                  <strong>One active event at a time.</strong> Photos always attach to whichever
                  event is currently active. Switching the active event is an admin operation and
                  scopes everything cleanly.
                </li>
                <li>
                  <strong>Direct-to-folder publish</strong> works in Chrome/Edge. You pick a
                  destination folder once, PhotoFlow remembers it across reloads, and files land
                  directly on disk in a subfolder named after the collection — no ZIP step.
                </li>
                <li>
                  <strong>Original files are preserved.</strong> Exports are made from the
                  original on demand. Resizing or re-encoding for export doesn't touch what's in
                  the archive.
                </li>
                <li>
                  <strong>AI captioning is optional per event.</strong> If an event is set with
                  AI off, uploads still process normally but skip the Claude pass.
                </li>
              </ul>
            </section>

            <section className="mb-5">
              <h2 className="h4 mb-3">Where to find more detail</h2>
              <p>
                Once you're signed in, the <strong>Help</strong> link in the user dropdown
                (top-right) opens a longer reference with every feature, page, and edge case
                documented. That's the right place to look when you need the specifics for
                anything described above.
              </p>
            </section>

            <section>
              <div className="card border-0 shadow-sm">
                <div className="card-body p-4">
                  <h3 className="h5 mb-3">Ready to start?</h3>
                  <p className="mb-3">
                    If you already have an account, sign in. Otherwise request access and
                    the admins will get you set up.
                  </p>
                  <div className="d-flex gap-2 flex-wrap">
                    <Link href="/login" className="btn btn-primary">
                      Sign in
                    </Link>
                    <Link href="/signup" className="btn btn-outline-secondary">
                      Request access
                    </Link>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </main>

      <footer className="bg-dark text-white-50 py-3 text-center small">
        <div className="container">PhotoFlow</div>
      </footer>
    </div>
  );
}

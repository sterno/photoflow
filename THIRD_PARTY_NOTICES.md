# Third-Party Notices

PhotoFlow itself is licensed under the **GNU Affero General Public License,
version 3 or later** (see [LICENSE](./LICENSE)). PhotoFlow depends on a number
of third-party packages, each of which is distributed under its own license.
This file calls out the dependencies whose licenses impose obligations beyond
"keep the upstream LICENSE file" — operators distributing PhotoFlow as a
**binary** (e.g., a built Docker image, a packaged tarball) should read it
carefully.

If you are only running PhotoFlow from source on your own machine, or pointing
contributors at this GitHub repository, the upstream `LICENSE`/`NOTICE` files
that ship inside `node_modules/` after `npm install` are sufficient to satisfy
attribution requirements.

---

## Binary distribution warning

The PhotoFlow source tree itself contains **no bundled third-party binaries**.
The [`Dockerfile`](./Dockerfile) in this repository is a recipe — a
*downstream* operator who runs `docker build` to produce an image, or who
otherwise packages PhotoFlow into a redistributable binary artifact,
**becomes the distributor of those third-party binaries** and takes on the
corresponding compliance obligations. The PhotoFlow project does not publish
prebuilt Docker images.

The dependencies that matter for binary redistribution are listed below.

---

## `ffmpeg-static` — GPL-3.0-or-later (wrapping GPL/LGPL ffmpeg binaries)

The [`ffmpeg-static`](https://www.npmjs.com/package/ffmpeg-static) npm package
ships prebuilt `ffmpeg` binaries. Those binaries are built from the
[FFmpeg project](https://ffmpeg.org/), whose source is licensed under
**LGPL-2.1-or-later** by default, with **GPL-2.0-or-later** or
**GPL-3.0-or-later** components included depending on configuration flags.

PhotoFlow's own AGPL-3.0-or-later license is GPL-compatible, so combining
PhotoFlow's source with `ffmpeg-static` introduces no licensing conflict.

**If you redistribute a PhotoFlow binary** (e.g., publish a Docker image to a
registry, ship a tarball, distribute an installer):

- You must comply with the GPL/LGPL terms of the bundled `ffmpeg` binary.
  At minimum, this means accompanying the binary distribution with the GPL/LGPL
  license text and either (a) the corresponding source for the binary or
  (b) a written offer to provide the source on request.
- See the FFmpeg project's
  [Legal page](https://ffmpeg.org/legal.html) for authoritative guidance.

**If you avoid this**, e.g., by replacing `ffmpeg-static` with a system
`ffmpeg` provided by the runtime environment, the bundled-binary obligations
do not transfer to your distribution. The PhotoFlow source as published here
does not transfer them either.

## `sharp` → `libvips` — Apache-2.0 (wrapping LGPL-2.1 libvips)

[`sharp`](https://www.npmjs.com/package/sharp) is licensed under
**Apache-2.0**. Its prebuilt native bindings link against
[libvips](https://www.libvips.org/), which is licensed under
**LGPL-2.1-or-later**.

For source distribution this requires no action — LGPL permits dynamic linking
from non-LGPL code without affecting the linker's license.

**If you redistribute a PhotoFlow binary** that bundles the prebuilt `sharp`
binary, include the libvips LGPL-2.1 license text in your distribution's
third-party notices and provide a way for recipients to obtain the libvips
source (typically by linking to the project page is sufficient under §6).

## `bootstrap` — MIT

[Bootstrap](https://getbootstrap.com/) is licensed under MIT. The license
requires preserving Bootstrap's copyright notice in any distribution of the
CSS/JS. For source distribution, the `LICENSE` file shipped in
`node_modules/bootstrap/` satisfies this. Binary distributions that bundle
Bootstrap should aggregate that notice into their redistribution notices.

---

## Other notable licenses

The following dependencies use **Apache License 2.0**, which under §4(d)
requires preserving any upstream `NOTICE` file in derivative distributions.
For source distribution from this repo, `npm install` preserves the
`NOTICE` files inside `node_modules/` automatically — no action needed.
Binary redistributors should aggregate them.

- `@prisma/client`, `@prisma/adapter-neon`, `prisma`
- `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`, `@aws-sdk/s3-request-presigner`
- `@neondatabase/serverless`
- `idb-keyval`
- `typescript`
- `sharp` (Apache-2.0 wrapper around the LGPL libvips noted above)

The following licenses impose no special obligation beyond preserving the
upstream LICENSE file that already ships in `node_modules/`:

- **MIT**: `@anthropic-ai/sdk`, `archiver`, `bcryptjs`, `bootstrap`,
  `exifr`, `jsonwebtoken`, `multer`, `next`, `pg`, `react`, `react-bootstrap`,
  `react-dom`, `resend`, `tailwindcss`, `tsx`, `eslint`,
  `@next/eslint-plugin-next`, `@tailwindcss/postcss`, all `@types/*`,
  plus `archive-viewer/`'s `vite`, `@vitejs/plugin-react`, and
  `vite-plugin-singlefile`.
- **ISC**: `next-auth`, `@auth/prisma-adapter`.
- **BSD-2-Clause**: `dotenv`.

---

## Generating an exhaustive third-party report

For a verbatim, machine-generated dump of every transitive dependency's
license and copyright, run:

```bash
npx license-checker --production --csv > third-party-licenses.csv
```

(or any equivalent tool, e.g. `npx licensee`, `npx license-report`). This is
the recommended approach for any operator producing a binary distribution who
needs a complete inventory to ship alongside their artifact.

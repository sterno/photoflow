import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Inline JS + CSS into index.html so the viewer opens directly from file://.
// Chrome blocks <script type="module"> and <link crossorigin> when loaded
// from a file:// origin (treated as a unique origin per file with no CORS),
// which would break every cross-file asset reference. Inlining sidesteps the
// whole problem.
//
// manifest.js stays separate — it's a non-module <script src="./manifest.js">
// which file:// loads fine, and it's regenerated per-archive by the exporter.
export default defineConfig({
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true })],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Singlefile inlines everything; assetsInlineLimit doesn't matter much
    // here but we still bump it so any tiny supplementary asset gets inlined
    // via data URI rather than emitted as a separate file.
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
  },
});

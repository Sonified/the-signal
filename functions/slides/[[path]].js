// The slide videos on the main site, as the standalone presentation serves
// them (documents/cloud-presentation-backup.md): every /slides/<file>.mp4
// request runs through the R2 handler (tools/presentation-media-handler.mjs),
// which serves only the manifest's files from the immutable release prefix,
// with byte ranges, ETags and its own Cross-Origin-Resource-Policy (Pages'
// _headers do not reach a Function's responses). _routes.json at the root
// runs this Function for /slides/* alone, leaving out the previews and the
// PNGs, which stay static assets. Needs the Pages project's R2 binding
// SLIDE_MEDIA (bucket solarmeditation-media); without it a video answers 503.
// Locally, tools/serve.mjs serves slides/ from disk as before.
import manifest from '../../documents/tsc-2026-media-manifest.json';
import { createSlideMediaHandler } from '../../tools/presentation-media-handler.mjs';

export const onRequest = createSlideMediaHandler(manifest);

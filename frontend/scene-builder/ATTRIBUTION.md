# Vendored pose-toolkit

Copied on 2026-10-12 from the local fork at
`/Volumes/Data/Users/paul/development/src/github/poser/pose-toolkit`, commit
`b9c70cd5001bde39f1b0c0532222a57cc054a809` (clean working tree).

The editor source is licensed under GPL-3.0; the original LICENSE, README, and
CONTRIBUTING documents are retained here. The parent app's existing LICENSE is
unchanged; it does not replace the licenses of this editor or its dependencies.

Dependencies:

- mannequin-js 5.2.3 — GPL-3.0, https://github.com/boytchev/mannequin.js
- Three.js 0.163.0 — MIT, https://github.com/mrdoob/three.js
- Pose gallery: Quaternius Universal Animation Libraries 1 and 2, as attributed
  by the fork's original README and manifests. Preserve their runtime assets and
  original metadata when updating the library.

Local adaptations include Vite multi-page packaging, local fonts, asset URL
resolution, the Studio message bridge, session snapshots, rendering suspension,
a shared PNG capture compositor, and WebM previews for CEF builds without H.264. Regeneration scripts are retained for
maintainers but are not executed during installation or app builds.

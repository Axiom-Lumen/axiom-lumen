# Vendored webfonts

These files are committed so `next build` never depends on Google Fonts or another font CDN. They are loaded
through `next/font/local` in `app/layout.tsx` and served as application assets.

## Provenance

### Fraunces

- Source: <https://github.com/undercasetype/Fraunces>
- Commit: `7ccdec31c6028118dce3e47fe864e3744460371d`
- Upstream path: `fonts/webfonts/variable/Fraunces[SOFT,WONK,opsz,wght].woff2`
- Local file: `fraunces-variable.woff2`
- SHA-256: `e6638ea113d0027354a08f957a4068975c8066395a0d0f7bb7861f6409621be3`
- License: `licenses/FRAUNCES-OFL.txt`

### IBM Plex Sans and Mono

- Source: <https://github.com/IBM/plex>
- Commit: `bf260093582f04622aacc1e9f9ca604d7ccd0c42`
- Upstream paths: `packages/plex-sans/fonts/complete/woff2/` and
  `packages/plex-mono/fonts/complete/woff2/`
- License: `licenses/IBM-PLEX-OFL.txt`

| Local file | Weight | SHA-256 |
|---|---:|---|
| `ibm-plex-sans-regular.woff2` | 400 | `ba711a3085ff9f27440b6b9c4550cfc47c97bf36591d5da958b975bb3add8c1a` |
| `ibm-plex-sans-medium.woff2` | 500 | `5660f8a658f8bb50dbc005232f885eadffd2bc1c235c4f6fbb63469d1f9cde6d` |
| `ibm-plex-sans-semibold.woff2` | 600 | `f78048030eab62e860efa39a0df79e2e5581bf122eb95b9bc42c0b8a4988d205` |
| `ibm-plex-mono-regular.woff2` | 400 | `ba204497f16b6d334cee9d1e963a831b73e3a56e1d6300a8489d18df7214b350` |
| `ibm-plex-mono-medium.woff2` | 500 | `33faf307fa6031fb4062276d7320a6d632de890cbb347576fd80cfa01077bc25` |

When updating a font, use an official upstream release or pinned commit, replace its license if needed, record
the new provenance and digest here, and run the full CI build before committing.

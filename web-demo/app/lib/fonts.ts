/**
 * Self-hosted faces, served from app/public/fonts:
 *   Switzer (sans) and Sentient italic (accent): Fontshare, ITF Free Font License.
 *   JetBrains Mono (code, labels, data): SIL OFL, Latin subsets.
 * Registered with the FontFace API so the bundler never inlines them into CSS
 * and they load as separate, cacheable files. System fallbacks render first.
 */
const LATIN = "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";
const LATIN_EXT = "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF";

const FACES: Array<[string, string, FontFaceDescriptors]> = [
  ["Switzer", "/fonts/switzer-400.woff2", { weight: "400", display: "swap" }],
  ["Switzer", "/fonts/switzer-500.woff2", { weight: "500", display: "swap" }],
  ["Switzer", "/fonts/switzer-600.woff2", { weight: "600", display: "swap" }],
  ["Switzer", "/fonts/switzer-700.woff2", { weight: "700", display: "swap" }],
  ["Sentient", "/fonts/sentient-400-italic.woff2", { weight: "400", style: "italic", display: "swap" }],
  ["JetBrains Mono Variable", "/fonts/jetbrains-mono-latin.woff2", { weight: "100 800", unicodeRange: LATIN, display: "swap" }],
  ["JetBrains Mono Variable", "/fonts/jetbrains-mono-latin-ext.woff2", { weight: "100 800", unicodeRange: LATIN_EXT, display: "swap" }],
];

export function loadFonts(): void {
  if (typeof FontFace === "undefined") return;
  for (const [family, url, descriptors] of FACES) {
    const face = new FontFace(family, `url(${url}) format("woff2")`, descriptors);
    document.fonts.add(face);
    face.load().catch(() => {
      /* fall back to the system stack */
    });
  }
}

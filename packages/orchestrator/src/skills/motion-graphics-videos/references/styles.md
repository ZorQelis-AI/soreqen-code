# Styles

The style comes from the subject. Take the brand's colours from its logo, site or app first; derive the rest. Each direction below gives a palette shape and font pairs from Google Fonts — choose one and make it specific to the subject, never copy it as is.

| Direction | Feels | Background | Palette shape | Display · Text |
|---|---|---|---|---|
| **Night product** | precise, technical, premium | dark `grid` and `mesh` | near-black, cool ink, one hot accent (amber, lime, coral) | Space Grotesk · Inter Tight; Sora · DM Sans |
| **Daylight** | open, friendly, clear | light `gradient` and `mesh`, ink dark | off-white, deep ink, one saturated accent | Bricolage Grotesque · Figtree; Outfit · Manrope |
| **Editorial** | serious, crafted, confident | paper-light `solid` or `gradient`, grain 0.06 | cream, charcoal, one ink colour (oxblood, cobalt) | Fraunces · Instrument Sans; Playfair Display · Source Sans 3 |
| **Neon signal** | fast, loud, youthful | black `mesh` with two saturated glows | black, white, two neons that clash on purpose | Unbounded · Space Grotesk; Archivo Black · Archivo |
| **Soft tech** | calm, human, modern | pastel `mesh` | two pastels, a dark ink, a deeper accent | Plus Jakarta Sans · Plus Jakarta Sans; Urbanist · Nunito Sans |
| **Brutal** | blunt, memorable | `solid` blocks, `flash` and `cut` on beats, grain 0 | black, white, one primary | Anton · Inter Tight; Bebas Neue · IBM Plex Sans |
| **Cinematic** | dramatic, story | `image` backgrounds with dark overlays, grain 0.07 | from the footage; accent from its brightest colour | Cormorant Garamond · Inter Tight; Syne · Manrope |
| **Data** | factual, sharp | dark or light `grid` | neutral greys, one signal colour for the number that matters | IBM Plex Sans · IBM Plex Sans; JetBrains Mono for figures |

## Setting the theme

```js
theme: {
  bg: "#0E1116", ink: "#F5F2EA", muted: "#A3A8B4", accent: "#FFB547", accent2: "#6C8CFF",
  display: "'Sora', sans-serif", text: "'DM Sans', sans-serif", mono: "'JetBrains Mono', monospace",
  fonts: ["https://fonts.googleapis.com/css2?family=Sora:wght@500;600;700&family=DM+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=block"],
  grain: 0.05, radius: 26,
}
```
- The font families in `display`/`text` must be spelled as in the Google Fonts URL (spaces, not `+`). The QA reports a font that did not load.
- `muted` is the ink at about 60% contrast: for labels and supporting lines.
- `radius` sets cards, devices and images: 8–14 for sharp and technical, 24–32 for soft.
- A product shown on screen keeps its own fonts and colours inside its screenshot.

# Motion Kit: the film as data

Everything is in the `VIDEO` object at the top of index.html. The engine below it is not edited.

```js
const VIDEO = {
  size: "16:9",        // "16:9" 1920x1080 · "9:16" 1080x1920 · "1:1" 1080x1080 · "4:5" 1080x1350
  fps: 30,             // 60 for fast motion
  audio: null,         // "voiceover.mp3" or "music.mp3", beside index.html: leads the clock, muxed on export
  vignette: true,      // a soft dark edge on every frame
  theme: { bg, ink, muted, accent, accent2, display, text, mono, fonts: [googleFontsUrl], grain: 0.05, radius: 26 },
  scenes: [ /* one per rundown row */ ],
};
```

Colour fields anywhere take a hex or a theme name: `"accent"`, `"ink"`, `"muted"`, `"accent2"`, `"bg"`.

## A scene

```js
{
  name: "proof",                 // shown in QA and ?debug=1
  dur: 3.6,                      // seconds
  ink: "#14161C",                // text colour for this scene (set it on light backgrounds)
  bg: { type: "mesh", colors: ["#0E1116", "#1C2440", "#FFB547"] },
  camera: { from: { x: -40, y: 0, zoom: 1, rot: 0 }, to: { x: 40, zoom: 1.05 }, ease: "inOut", shake: 0.25 },
  layers: [ /* below */ ],
  out: { type: "push", dir: "left", dur: 0.6 },   // the transition into the next scene
}
```

**Camera.** `from` → `to` over the whole scene. `x`/`y` in stage pixels, `zoom` (1 = framed), `rot` in degrees, `shake` 0–1 of handheld drift (0.25 default; 0 for still graphic work). Without `camera` a scene still pushes in gently (zoom 1 → 1.035). Layers with `depth` move with parallax: 0.3–0.6 near, -0.2 to -0.4 far.

**Backgrounds** (`bg.type`):
- `mesh` — soft colour fields drifting: `colors` [base, glow, glow…]. The richest; the default for a hero moment.
- `gradient` — `colors`, `angle`; the angle breathes.
- `grid` — a receding perspective grid: `color`, `glow`, `cell`, `speed`. Technical, product, data.
- `image` — `src`, `overlay` (a CSS gradient to keep text readable); a slow push.
- `solid` — `color`. Rare: only when the scene itself is very busy.

**Transitions** (`out.type`, with `dur` 0.4–0.9 s):
`cut` · `push` (`dir` left/right/up/down) · `whip` (a fast push, motion-blurred) · `zoom` (into the next scene) · `wipe` (`dir`) · `iris` (a circle opening) · `flash` (an ink flash on a beat) · `fade` (sparingly).

## Layers

Every layer takes: `at` (seconds into its scene), `dur` (entrance length, about 0.9), `out` (seconds into the scene when it leaves; omit to stay), `outDur`, `x`, `y` (offset from the centre), `align` ("center" | "left" | "right": which edge sits on x), `depth`, `ease` ("expo" default, "out", "inOut", "back", "spring", "linear").

### title — the line
```js
{ type: "title", text: "Ship it *today*", size: 150, weight: 600, reveal: "rise", at: 0.3, w: 1200, color: "ink" }
```
`reveal`: `rise` (words lift in through a blur — the default), `mask` (words slide up out of a slot), `chars` (letters roll in, for short display words), `type` (typed, with a caret), `scale` (the line settles from large), `fade`. `stagger` between words (0.09). `*word*` takes the accent colour; `highlight: "marker"` draws a marker under the marked words. `w` sets the wrapping width.

### label — a small line in the world
```js
{ type: "label", text: "Now in beta", icon: "✦", y: 150, at: 1.1, pill: true, size: 34 }
```

### counter — a number that counts
```js
{ type: "counter", from: 0, to: 98.6, decimals: 1, prefix: "", suffix: "%", size: 220, at: 0.2, dur: 1.6 }
```

### image — a picture, a screenshot, a photo
```js
{ type: "image", src: "shots/home.png", w: 1100, h: 640, fit: "cover", radius: 24, at: 0.3, rotate: -2, float: true }
```

### device — a screen in a frame
```js
{ type: "device", device: "browser", image: "shots/app.png", w: 1100, x: 300, at: 0.2, scroll: 900, scrollDur: 2.4, turn: -12 }
```
`device`: `browser` (a window with its bar) or `phone`. `scroll` pixels the screenshot scrolls inside the screen; `turn` degrees of Y rotation it swings in from.

### cards — several things, one at a time
```js
{ type: "cards", layout: "row", items: [{ icon: "⚡", title: "Fast", text: "Builds in seconds" }, …], at: 0.3, stagger: 0.22, cycle: 0.8 }
```
`layout`: `row`, `stack` (a fanned pile), `grid` (`cols`). `cycle` lights each card in turn (seconds per card). Three or four items, never more; titles of one to three words.

### chart — bars that grow
```js
{ type: "chart", data: [{ label: "2023", value: 12 }, { label: "2024", value: 31 }, { label: "2025", value: 88, color: "accent" }], w: 1100, h: 520, suffix: "k", at: 0.3 }
```

### code — code being written
```js
{ type: "code", code: "const app = await soreqen.build('site')\nawait app.deploy()", size: 34, w: 1100, at: 0.2, typeDur: 2 }
```

### shape — a line that draws
```js
{ type: "shape", shape: "ring", size: 760, stroke: 5, color: "accent", at: 0.1, dur: 1.8, turn: 6, opacity: 0.8 }
```
`shape`: `ring`, `rect`, `line`. Behind a counter or a logo, it ties the frame together.

### logo — the mark
```js
{ type: "logo", text: "Acme", size: 180, reveal: "shine", at: 0.3 }      // or src: "logo.svg"
```
`reveal`: `shine` (settles in, a light sweeps across), `pop` (a springy arrival).

### particles — a field of light
```js
{ type: "particles", count: 90, color: "accent", size: 3, speed: 18, opacity: 0.5 }
```

### html — anything else, as a function of time
```js
{
  type: "html", at: 0.4,
  html: '<svg width="900" height="300"><path id="p" d="M0 250 C 200 50, 500 300, 900 40" fill="none" stroke="#FFB547" stroke-width="6" pathLength="1" stroke-dasharray="1 1"/></svg>',
  draw(t, el, kit, p, q) { el.querySelector("#p").setAttribute("stroke-dashoffset", 1 - kit.prog(t, 0.4, 1.6, "inOut")); },
}
```
`t` is seconds into the scene; `p` the entrance progress (0 → 1), `q` the exit. `kit` has `prog(t, start, dur, ease)`, `noise(t, seed)` (smooth, -1…1), `hash(n)`, `lerp`, `clamp`, `color(name)`, `theme`, `W`, `H`. Never timers, CSS animations or transitions, Math.random or Date.now: the QA blocks them, because the frame must be the same however it is reached.

## Recipes

**A push from one idea into the next.** Scene A `camera: { to: { zoom: 1.12 } }` and `out: { type: "zoom", dur: 0.7 }`; scene B starts wide `camera: { from: { zoom: 0.92 }, to: { zoom: 1 } }`.

**A product moment.** `grid` background, a `device` at `x: 300` with `turn: -12`, the title `align: "left"` at `x: -820` with `w: 560`, a `label` under it.

**A number that lands.** A `ring` shape with `depth: -0.3` behind a `counter` (size 200–240), a `title` of three or four words under it in `muted` at 56–64 px, revealed with `mask`.

**The close.** A light `mesh` with `ink` set dark, `logo` with `shine`, a `label` with the address, `pill: false`.

**9:16.** Stage 1080×1920: titles 110–150 px with `w: 900`, keep text between y -620 and 560 (clear of the top 12% and bottom 20% where the platform draws its own interface).

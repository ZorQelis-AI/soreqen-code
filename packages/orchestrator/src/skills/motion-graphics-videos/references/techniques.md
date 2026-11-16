# Techniques

## Timing
- Scene length: 2.5–4.5 s; a hook 1.5–2.5 s; a hold on the close 1–1.5 s. A film under 30 s has 6–10 scenes.
- Entrances 0.7–1.1 s with `expo` (fast start, long settle). Exits 0.35–0.5 s, quicker than entrances. Springs (`spring`, `back`) only for small objects and logos.
- Order inside a scene: the camera begins moving at 0; the line enters at 0.2–0.4; the main visual 0.3–0.5 s after; a label last. The eye goes where something has just moved: one thing at a time.
- Stagger: words 0.06–0.1 s, letters 0.02–0.03, cards 0.18–0.25.
- On music, put scene starts on beats (references/assets-and-sound.md) and land the biggest move on the drop. With voice, start each scene 0.1–0.2 s before its sentence.

## Type
- One display face for titles, one text face for labels and body, a mono face only for code. Weight 500–700 for display; 400–500 for text.
- Titles 96–180 px on the 1080 stage, supporting lines 56–72, labels 32–40. Two sizes on screen at once, three at most.
- Six words per line at most; break lines by meaning (`w` sets the width). No full stops on short claims. Sentence case.
- Emphasis: the accent colour on one or two words with *asterisks*. The marker highlight once per film.

## Contrast and colour
- Text needs a clearly darker or clearly lighter field behind it: 4.5:1 for small text, 3:1 for titles. On a light mesh, set the scene's `ink` dark.
- Three colours carry a film: background, ink, accent. A second accent for a second meaning only. Saturated colour is for objects and glows, not for whole backgrounds behind text.
- Change the background colour with a reason the eye sees: a `wipe`, a `zoom` into a coloured field, a cut on a beat.

## The camera
- Every scene moves: a push in (zoom 1 → 1.05) while holding, a drift (x -40 → 40) across a wide frame, a pull back (zoom 1.3 → 1) for a reveal, a slight roll (rot -1.5 → 0) for energy.
- Push toward what is speaking. Do not move the camera fast while text is entering: the move is slow, the transition is fast.
- `depth` makes the world: titles 0, devices and images 0.3–0.5, rings and shapes behind -0.2 to -0.4.

## Transitions
Choose per boundary and vary them:
- `zoom` — deeper into the same idea (from a claim into its proof).
- `push` — the next thing in a sequence; keep one direction through a sequence.
- `whip` — energy, a beat, a change of topic.
- `wipe` — a reveal, a before/after, a colour change.
- `iris` — focusing on one thing; the close.
- `flash` — a hit on the beat, once or twice in a film.
- `cut` — on the beat, between scenes of the same world; the most underrated transition.
- `fade` — time passing. Rarely.
Durations 0.45–0.8 s. The incoming scene's first layer at `at` 0.1–0.3 so the frame is not empty when the transition clears.

## Backgrounds
- `mesh` for hero moments and the close; `gradient` for calm text scenes; `grid` for product, data and technical scenes; `image` for real places and people (with an `overlay` dark enough for text).
- Grain 0.03–0.07 makes gradients feel filmed and hides banding; 0 for crisp flat-graphic styles.

## Pacing a 30-second promo
hook (2 s) → the problem or the promise (3 s) → proof: a number (3.5 s) → inside the product (4–5 s) → a second proof or feature (3.5 s) → the line that sums it up (3 s) → the close (3 s). Seven scenes, four kinds of transition, one special moment (the biggest move, the brightest scene) placed two-thirds of the way in.

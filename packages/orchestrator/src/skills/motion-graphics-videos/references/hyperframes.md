# HyperFrames essentials

HyperFrames renders a video from an HTML page: the DOM declares timing with data attributes, a paused GSAP timeline is seeked frame by frame, and the CLI captures and encodes it. Needs Node 22+ and FFmpeg.

## Loop
1. Scaffold: npx hyperframes init <name> --non-interactive --example=<example> (it refuses a non-empty folder and creates a subfolder; move files up if needed).
2. Author index.html (structure below).
3. npx hyperframes lint after structural edits; npx hyperframes check as the final gate (lint, runtime errors, layout, contrast).
4. npx hyperframes snapshot --at 1.5,4,7.2 and view the frames.
5. npx hyperframes render --quality draft, then --quality high --output out.mp4.
6. ffprobe -v error -show_format out.mp4 to confirm duration and size.
Prefer --json flags for machine-readable output. npx hyperframes doctor --json checks the environment (it always exits 0; read the payload).

## Composition contract
- Root: <div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-duration="30"> directly in <body>, with an explicit pixel width and height in CSS.
- Clips: any element with class="clip", data-start, data-duration and data-track-index. The framework shows and hides clips; never animate a .clip's visibility or display yourself.
- One timeline: window.__timelines = window.__timelines || {}; const tl = gsap.timeline({ paused: true }); ... window.__timelines["main"] = tl; built synchronously at load.
- Render duration is the root's data-duration, not the timeline's length.
- Audio and video: <audio>/<video> elements as direct children of the root, with data-start and data-duration; the framework owns playback. Set volume with data-volume.

## Rules that fail silently
- Nested clips use GLOBAL time: a clip inside a scene needs data-start in absolute seconds, not relative to its parent. Wrong values render blank and lint passes. Snapshot the midpoints to catch it.
- Fades: never fade a .clip element. Put the fade on an inner wrapper and add a hard kill at the boundary: tl.set(wrapper, { opacity: 0 }, boundary).
- Determinism: no Date.now, no unseeded Math.random, no network at render time, no repeat: -1 (use a finite count).
- Animate only visual properties: transform (x, y, scale, rotation), opacity, filter, clip-path, colors. Never tween display or visibility.
- Full-screen backgrounds go on a full-bleed child (position:absolute; inset:0), not on the root itself, or the rendered frame can come out black.
- Every id unique across the whole page.
- No <br> in body text; size and set display:block on anything transformed.

## Sub-compositions
A scene in its own file is loaded with data-composition-src on a host element; that file's root must be wrapped in <template>, with its <style> and <script> inside the template, and the host's data-composition-id must equal the template root's id and its timeline key exactly.

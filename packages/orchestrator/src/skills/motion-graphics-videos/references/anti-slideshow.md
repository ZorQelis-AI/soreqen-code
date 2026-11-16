# Not a slideshow

A slideshow is a sequence of pages that appear. A film is a world the camera moves through. Read the contact sheet against this list before showing anything.

## What makes it a slideshow, and the fix

| You see | Why it reads as slides | Fix in Motion Kit |
|---|---|---|
| Every scene: a heading centred, a smaller line under it | the same layout repeated is a template | vary `align` and `x`; give scenes a main visual (`device`, `counter`, `image`, `chart`) that the text sits beside |
| A heading, a subheading and a sentence in one scene | three tiers of text are a document | one line, one label; the rest becomes the next scene or the voice |
| Three cards in a row as the whole point | the default "features" page | one feature per scene; `cards` only as a recap with `cycle` |
| Fade, fade, fade | nothing connects the scenes | `zoom` into the proof, `push` along a sequence, `cut` on a beat |
| A frame where nothing moves | a page held on screen | a camera move in every scene, a drifting background, a label that arrives late |
| Text the size of a caption | a page read from a distance | titles 96 px and up; one size step between title and label |
| Everything appears at once | no direction for the eye | stagger with `at`: line, then visual, then label |
| Each scene a new colour, a new font | no world | one palette and two fonts for the film; colour changes only on a visible cue |
| Logo → feature → feature → feature → logo | the template arc | pick a concept (references/concepts.md) and let it shape the order |

## A director's checks on the contact sheet
1. In each frame, where does the eye go first? If the answer is "the text, then nowhere", add the visual.
2. Could any frame be a slide in a deck? Rework that scene.
3. Cover the text: is the frame still alive (a background that drifts, a camera move, an object)?
4. Read only the titles in order: do they tell the story in under 30 words?
5. Is there one special moment — a reveal, the biggest move, the brightest scene — and only one?

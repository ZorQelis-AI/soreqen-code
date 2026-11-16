# Assets, music and sound effects

## Visual assets (check each license; record it in CREDITS.md)
- Icons: Lucide, Tabler, Phosphor, Heroicons (MIT), as SVG from npm (lucide-static, @tabler/icons) or the Iconify API saved to a file. Brand logos: Simple Icons (CC0 for the SVGs; trademarks still belong to their owners, use only to refer to the brand).
- Illustrations: unDraw (free, no attribution), Open Peeps and Humaaans (CC0), Storyset (attribution).
- Photos and footage: Unsplash and Pexels (free to use, no attribution required, no selling unaltered copies), Pixabay. Download the file into assets/ rather than hotlinking.
- 3D: Poly Haven (CC0 models, HDRIs, textures), Kenney (CC0), Sketchfab (check each model's license, often CC BY).
- Fonts: Google Fonts (OFL), Fontshare (free for commercial use). Load them locally from files in the project.
- Lottie animations: LottieFiles (check the license of each), played through the engine's Lottie adapter so they follow the timeline.
- Textures: grain, paper, noise: generate them (SVG feTurbulence) rather than download.
- HyperFrames registry: about 400 ready blocks and components (glitch, CRT, film grain, shimmer, charts, code and terminal windows, maps, confetti, transitions): npx hyperframes catalog --search <word>, npx hyperframes add <name>.

## Music
Sources, in order: the person's own or licensed music; YouTube Audio Library (free, some need attribution); Pixabay Music (free, Pixabay license); Free Music Archive and ccMixter (filter to CC BY or CC0, credit as required); Incompetech (CC BY, credit Kevin MacLeod). Avoid anything without a clear license.
Choosing: tempo by energy (70 to 90 BPM calm, 100 to 120 confident, 120 to 140 energetic), mood by tone, instrumental only under a voice, a clear ending or a section you can end on.
Fitting: trim with ffmpeg -ss/-t, fade in 0.5 s and out 1.5 to 3 s (afade), and land the final hit on the end card. npx hyperframes beats music.mp3 gives beat times for cutting on the beat.
Generating a bed locally when nothing licensed fits: synthesize a soft pad from a chord progression with numpy (sum of detuned sine and saw partials per chord, slow attack and release envelopes, low-pass), add a gentle kick and hat pattern at the chosen BPM, then ffmpeg "aecho=0.8:0.7:60:0.3,lowpass=f=6000" for space. Keep it simple and in key; it sits under the voice.

## Sound effects
Sources: Kenney audio packs (CC0), Freesound (filter to CC0), Pixabay sound effects, Sonniss GDC bundles (royalty free). Or generate them with ffmpeg, which is fully licensed and exact in length:
- Whoosh (0.6 s): ffmpeg -f lavfi -i "anoisesrc=d=0.6:c=pink:a=0.6" -af "bandpass=f=1200:w=900,afade=t=in:d=0.25,afade=t=out:st=0.3:d=0.3,volume=0.8" whoosh.wav
- Riser (2 s): ffmpeg -f lavfi -i "anoisesrc=d=2:c=white:a=0.4" -af "highpass=f=400,lowpass=f=8000,afade=t=in:d=1.9,volume=0.7" riser.wav (pair with a sine sweep: aevalsrc="0.3*sin(2*PI*(200+600*t)*t)":d=2)
- Impact or hit (0.8 s): ffmpeg -f lavfi -i "aevalsrc=0.9*sin(2*PI*(60+120*exp(-8*t))*t)*exp(-4*t):d=0.8" -af "lowpass=f=900" hit.wav
- Click or tick (0.05 s): ffmpeg -f lavfi -i "aevalsrc=0.6*sin(2*PI*2400*t)*exp(-120*t):d=0.05" click.wav
- Pop (0.15 s): ffmpeg -f lavfi -i "aevalsrc=0.7*sin(2*PI*(900-600*t*6)*t)*exp(-25*t):d=0.15" pop.wav
- Shimmer (1.2 s, for a logo): sum several high sines (2000 to 5000 Hz) with tremolo and a slow fade: aevalsrc="0.15*(sin(2*PI*2637*t)+sin(2*PI*3136*t)+sin(2*PI*3951*t))*exp(-2*t)":d=1.2, then aecho=0.8:0.6:40:0.4
- Typing: a short burst of clicks at random but seeded intervals, mixed under UI typing.
Place each effect slightly before the visual peak (whooshes 2 to 4 frames early), keep them 10 to 15 dB under the voice, and never stack more than two at once.

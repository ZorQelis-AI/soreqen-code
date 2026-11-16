# Voiceover with local text to speech

## Engines (all run on this machine)
1. Kokoro-82M through HyperFrames: npx hyperframes tts "Text of one line." -o vo/01.wav (run npx hyperframes tts --help for the voice and speed flags of the installed version). Downloads its model on first use.
2. Kokoro through Python: pip install kokoro-onnx soundfile in a project virtual environment (never the global Python; it upgrades numpy, which breaks other packages), plus the kokoro model and voices files from the kokoro-onnx release page.
3. Piper (fast, light, many voices): pip install piper-tts in a venv, download a voice (.onnx plus .onnx.json, for example en_US-ryan-high or en_GB-alba-medium), then: echo "Text" | piper --model en_US-ryan-high.onnx --output_file vo/01.wav
4. Chatterbox (open source, MIT, expressive, emotion intensity control; best with an NVIDIA GPU): pip install chatterbox-tts in a venv, then in Python: from chatterbox.tts import ChatterboxTTS; m = ChatterboxTTS.from_pretrained(device="cuda"); wav = m.generate(text, exaggeration=0.5, cfg_weight=0.5); torchaudio.save("vo/01.wav", wav, m.sr). Use it when the read needs energy or emotion that Kokoro does not carry.
Network voices (edge-tts, ElevenLabs, HeyGen) are not local: use them only if the person asks.

## Voices (Kokoro)
- Warm, natural narrator: af_heart (female, US), am_michael or am_adam (male, US).
- Bright product demo: af_nova, af_bella.
- British: bf_emma, bm_george.
Generate the same line with two or three voices and listen-check by duration and pacing, or let the person choose when the voice matters to them. Keep one voice for the whole video.

## Pacing and naturalness
- One file per line or beat; it keeps timing exact and lets you fix one line without redoing all.
- Write for the ear: contractions, short sentences, numbers as words when they read better ("twenty percent"), brand names spelled the way they are said.
- Speed 0.95 to 1.05; slower for serious or technical content.
- Trim leading and trailing silence: ffmpeg -i in.wav -af silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse out.wav

## Timing
ffprobe -v error -show_entries format=duration -of csv=p=0 vo/01.wav gives each clip's length. Lay clips end to end with 0.25 to 0.5 s gaps; each scene's duration is its line's duration plus its gap and any visual hold. For captions with word timing, npx hyperframes transcribe vo/full.wav produces word timestamps locally.

## Mix and master (ffmpeg)
- Join lines: list them in a concat file and run ffmpeg -f concat -safe 0 -i lines.txt -c copy vo/full.wav.
- Clean the voice: highpass at 80 Hz, gentle compression: -af "highpass=f=80,acompressor=threshold=-20dB:ratio=3:attack=5:release=80".
- Duck music under the voice: ffmpeg -i music.wav -i vo/full.wav -filter_complex "[0:a][1:a]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[bed];[bed][1:a]amix=inputs=2:duration=longest[mix]" -map "[mix]" mix.wav
- Loudness to platform: ffmpeg -i mix.wav -af loudnorm=I=-14:TP=-3:LRA=11 master.wav (TP -3 leaves room for AAC's overshoot).
- Check: ffmpeg -i master.wav -af ebur128=peak=true -f null - and read the summary.

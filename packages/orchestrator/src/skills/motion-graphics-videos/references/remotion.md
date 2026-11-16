# Remotion essentials

Remotion renders React components frame by frame. Scaffold with npx create-video@latest (choose a blank or Tailwind template), preview with npx remotion studio, render with npx remotion render <CompositionId> out/video.mp4.

## Building blocks
- Register compositions in src/Root.tsx: <Composition id="Promo" component={Promo} durationInFrames={900} fps={30} width={1920} height={1080} defaultProps={...} />.
- Time: const frame = useCurrentFrame(); const { fps, durationInFrames } = useVideoConfig();
- Interpolate: interpolate(frame, [0, 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) }). Always clamp.
- Springs: spring({ frame, fps, config: { damping: 200 } }) for natural settles; lower damping for bounce, used sparingly.
- Sequencing: <Sequence from={90} durationInFrames={120}> shifts time for its children (inside, useCurrentFrame starts at 0). <Series> lays scenes end to end.
- Layout: <AbsoluteFill> for full-frame layers.
- Assets: put files in public/ and reference them with staticFile("vo/01.wav"). Use <Audio src={staticFile(...)} /> and <Img>, <OffthreadVideo> for video.
- Duration from audio: calculateMetadata on the Composition can read audio durations (getAudioDurationInSeconds from @remotion/media-utils) and set durationInFrames, so the video always fits the voiceover.
- Fonts: @remotion/google-fonts (loadFont) or a local @font-face with staticFile; if loadFont hangs on this machine, use a local font file.

## Rules
- Everything must be a pure function of the frame: no Math.random without random(seed) from remotion, no Date, no CSS animations or transitions (they do not follow the frame). Drive every change from useCurrentFrame.
- Heavy CSS filters (large blur) slow rendering a lot and have crashed renders; prefer pre-blurred images or smaller blur radii.
- Render stills to check frames: npx remotion still <CompositionId> out/frame.png --frame=120.
- Final render: npx remotion render <CompositionId> out/video.mp4 --codec=h264 --crf=18. Check it with ffprobe.

## License
Free for individuals, non-profits and companies of up to 3 people; larger companies need a company license (remotion.pro). Mention this when the person's company may be larger.

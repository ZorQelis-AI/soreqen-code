/**
 * The frontend design skill: what turns "a UI" into a designed one.
 *
 * Its first version was a page of principles ("a deliberate visual point of
 * view", "a restrained palette"), and the models read it and still shipped
 * the same purple gradient, three emoji cards and a hero that said "Unlock
 * the power of…" (reported 13 Oct 2026: "trash, AI slop, generic and basic,
 * with the UX broken"). Principles do not survive a weak model; procedures
 * and named mistakes do. So this one makes the model commit to a written
 * brief before any code, names the tells of generated design one by one,
 * sets concrete defaults for type, spacing and colour, and makes looking at
 * the result at three widths part of the work. Worked visual directions and
 * the review pass are reference files, read when the work reaches them.
 */

import type { SkillDefinition } from "./builtin.js";

const DIRECTIONS = `
# Visual directions, worked

Adapt one to the product: keep the roles and the logic, change hues and faces to fit the brand. Never paste one unchanged. Check every text colour against its background (4.5:1 for body text). Load at most two font families (Google Fonts or Fontsource, font-display: swap).

## Editorial (publications, writing tools, portfolios, agencies)
- Palette: background #FAF8F3, surface #FFFFFF, text #1A1A1A, muted #6B665E, border #E6E0D6, accent #B3261E (one deep, confident colour).
- Type: a serif display face (Fraunces, Newsreader, Instrument Serif) with a clean sans for text (Inter, Source Sans 3). Large, tight headings (line height 1.05 to 1.15), body 17 to 18px at 1.6.
- Layout: an asymmetric 12-column grid, generous outer margins, hairline rules between sections, captions and small caps labels.
- Signature: a drop cap, numbered sections, or pull quotes set big.

## Technical (developer tools, APIs, infrastructure)
- Palette dark: background #0B0D10, surface #13161B, text #E6E8EB, muted #8A929C, border #232830, accent #3DDC97 or #F5A524. Light variant: #FFFFFF / #F6F7F9 / #0D1117 / #57606A / #D8DEE4.
- Type: Geist or Inter for text, JetBrains Mono or IBM Plex Mono for code, ids and numbers.
- Layout: real code and real terminal output as the hero, not illustrations; a faint grid or dot background at most; dense, scannable sections.
- Signature: copyable command blocks, keyboard shortcut chips, a live-looking status line.

## Warm consumer (food, local business, lifestyle, community)
- Palette: background #FFF7ED, surface #FFFFFF, text #2B1D14, muted #7A6352, border #F0E0CC, accent #C2410C, second accent #5F7F64 used rarely.
- Type: a soft serif or rounded display (Fraunces with soft optical size, Recoleta-like faces) with DM Sans or Nunito Sans.
- Layout: big real photography with consistent crops, short sections, clear opening hours, prices and location.
- Signature: a hand-drawn underline or stamp, menu-style lists with dotted leaders.

## Trust and money (finance, insurance, legal, B2B SaaS)
- Palette: background #FFFFFF, surface #F7F8FA, text #0F1B2D, muted #5B6576, border #E3E7ED, accent #0F766E or #1D4ED8 (a deliberate blue, not the default).
- Type: IBM Plex Sans or Inter with tabular figures for every number.
- Layout: precise tables, right-aligned numbers, clear plan comparison, security and compliance facts stated plainly.
- Signature: one excellent data visual (a real chart of the product's value), sparklines in tables.

## Industrial dashboard (ops, logistics, admin tools)
- Palette: background #F4F4F5, surface #FFFFFF, text #18181B, muted #71717A, border #E4E4E7, accent #EA580C; status colours green #16A34A, amber #D97706, red #DC2626.
- Type: Inter Tight or Barlow, monospace for ids, 13 to 14px dense UI text.
- Layout: a sidebar plus a working area, sticky table headers, filters that persist, bulk actions; content first, chrome second.
- Signature: status pills with clear meaning, a compact activity timeline.

## Playful (kids, games, creator tools, events)
- Palette: background #FFFBEB, text #1F2937, two bold accents used in solid blocks (#F43F5E, #3B82F6), borders #111827.
- Type: Space Grotesk, Bricolage Grotesque or Baloo 2 for display, a plain sans for text.
- Layout: neo-brutalist blocks, 2 to 3px solid borders, offset hard shadows (4px 4px 0 #111827), stickers or badges.
- Signature: one bouncy, purposeful micro-interaction (a button that presses in), never everything animated.

## Premium (luxury, hospitality, fashion, architecture)
- Palette: ivory #F6F3EE or near black #111111, text #1C1A17 or #EDE8E0, accent muted gold #A88B5B used for thin details only.
- Type: Cormorant Garamond or Playfair Display for display, Inter in small letterspaced capitals for labels.
- Layout: very generous whitespace, few words, full-bleed imagery, thin rules, slow fades (300 to 400ms).
- Signature: restraint itself: one striking image per screen.

## Calm health (wellbeing, healthcare, education)
- Palette: background #F7FAF9, surface #FFFFFF, text #12261E, muted #4F6B60, border #DCE7E2, accent #0E7C66.
- Type: Source Serif 4 for headings with Nunito Sans or Inter for text, roomy line height.
- Layout: short steps, plain-language copy, large form fields with help text, reassuring confirmations.
- Signature: soft, consistent illustrations in one style, progress shown kindly.

## Swiss modernist (studios, events, cultural, bold product launches)
- Palette: white #FFFFFF, black #0A0A0A, one signal red #E30613.
- Type: one grotesque (Inter Display, Neue Haas-like faces) in large, tight sizes; numbers as graphic elements.
- Layout: a strict visible grid, flush left, ragged right, big type as the image.
- Signature: oversized numerals or a single red element per screen.
`;

const REVIEW = `
# The review pass

Do this before saying any UI is done, and again after each round of fixes.

1. Run it. Start the dev server with run_command (run_in_background: true) and wait for its "ready" line, or open the built file.
2. Look at it at three widths in one browser_batch:
   resize to width 375 (phone), open the page, screenshot full_page; resize to 768, screenshot; resize to 1440, screenshot. Look at every screenshot with care, as a picky designer would.
3. Check for problems a screenshot hides:
   - browser_console_logs: no errors or failed requests.
   - Sideways overflow at 375px: content cut off at the right edge of the full_page screenshot, or a page that still moves after browser_interact scroll to the right, means something is wider than the screen. Find it and fix it.
   - Click through every link, button, tab and menu on the main flow with browser_interact; submit every form once with bad input and once with good input.
   - Tab through the page: is focus visible and in a sensible order? Does Escape close dialogs?
4. Judge against the brief and the gate, in this order, and fix the first failure before looking at the next:
   1. Broken: overlapping or cut-off content, overflow, console errors, dead buttons or links, unreadable contrast.
   2. Missing states: loading, empty, error, success, long content, no data.
   3. Hierarchy: the one most important thing on each screen is the most visible; nothing competes with it.
   4. Generic: any AI-slop tell from the skill's list; anything that looks like a template rather than this product.
   5. Craft: alignment to the grid, consistent spacing and radius, type scale used consistently, icon sizes.
5. Re-screenshot after fixes. Report what you checked, at which widths, and what remains imperfect.

Common fixes:
- Cramped mobile: reduce horizontal padding to 16 to 20px, stack columns, scale headings with clamp(), make tap targets 44px.
- Everything looks the same: vary section composition; give the primary action the only accent colour; increase contrast between heading and body sizes.
- Feels empty or generic: replace vague copy with specific facts about the product; add the signature detail from the brief; use real data in tables and charts.
- Feels busy: remove borders and shadows that do not separate anything; group related items with space instead of boxes; cut the palette back to neutrals plus one accent.
`;

export const FRONTEND_DESIGN: SkillDefinition = {
  name: "frontend-design",
  title: "Frontend design integrity: anti-generic UI/UX",
  kind: "conditional",
  description:
    "Any UI or UX work: a website, web or mobile app screen, dashboard, landing page, component, redesign or visual polish. Load before writing or changing any interface.",
  trigger: {
    words:
      /\b((build|create|make|design|redesign|develop)\b[^.\n]{0,30}\b(web ?sites?|(?<!call |call-)sites?|web ?pages?|web ?apps?|apps? (in|with) (react|next\.?js|vue|svelte|angular|tailwind)|portfolio|blog|storefront|ui|landing ?page)|sections?|pages?|buttons?|ui|ux|gui|ui\/ux|user interface|user experience|frontend|front-end|landing ?page|home ?page|dashboard|web ?app|web ?sites?|(?<!call |call-|use )sites?|web ?pages?|portfolio|blog|storefront|admin panel|component|components|layout|redesign|restyle|(?<!code |coding |naming |commit )styl(e|es|ing)|css|html|tailwind|shadcn|react|next\.?js|vue|nuxt|svelte|angular|astro|react native|flutter|swiftui|jetpack compose|electron|tauri|streamlit|gradio|(dark|light) (mode|themes?)|theme|responsive|mobile view|on mobile|navbar|sidebar|footer|hero|modal|screens?|page design|visual(ly)?|mock-?ups?|wireframes?|figma|design system|look and feel|aesthetics?|typography|fonts?|colou?r (scheme|palette)s?|palettes?|glassmorph\w*|spacing|padding|pixel[- ]perfect|sleek|premium (look|feel|design)|(app|screen|page|site|interface|mobile|website|product|landing) design|design (it|this|that|the|a|an|my|our)\b[^.\n]{0,25}\b(app|page|site|screen|interface|website|dashboard|ui|form|flow)|make it look|looks? (ugly|bad|off|broken|dated|generic|cheap|better|nicer|modern|boring|basic|plain|weird)|beautiful|prettier|polish(ed)? (the )?(ui|design|look|page|site)|animations?|onboarding (flow|screens?)|(sign ?up|log ?in|pricing|checkout|settings|profile) (page|screen|form|section))\b/i,
    strong:
      /^((build|create|make|design|redesign|develop)\b.*|ui|ux|gui|ui\/ux|user (interface|experience)|frontend|front-end|landing ?page|home ?page|dashboard|web ?app|admin panel|storefront|css|tailwind|shadcn|figma|wireframes?|mock-?ups?|navbar|typography|design system|look and feel|colou?r \w+|glassmorph\w*|pixel[- ]perfect|responsive|mobile view|on mobile|(dark|light) \w+|react native|jetpack compose|swiftui|flutter|page design|premium \w+|make it look|looks? \w+|polish.*|onboarding \w+|design (it|this|that|the|a|an|my|our)\b.*|\w+ design|(sign ?up|log ?in|pricing|checkout|settings|profile) \w+)$/i,
    paths: /\.(tsx|jsx|vue|svelte|astro|css|scss|sass|less|html)$/i,
  },
  source: "soreqen",
  refs: { "references/directions.md": DIRECTIONS.trim(), "references/review.md": REVIEW.trim() },
  files: ["references/directions.md", "references/review.md"],
  body: `
The goal is an interface a good product team would ship for this product: a clear point of view, real content, and nothing broken. A generic result is a failed result, however tidy.

## 1. Write the brief first, before any code
Put these six lines in your plan (and in DESIGN.md for a new project) and hold the work to them:
1. Who uses it, where, and the one action that matters most on each screen.
2. Direction: one named visual direction with a reason tied to the product. references/directions.md has nine worked directions; adapt one, never paste it.
3. Palette as hex with roles: background, surface, text, muted text, border, ONE accent, plus success, warning and danger.
4. Type: a display face and a text face (or one family in two weights) and a scale such as 12, 14, 16, 20, 24, 32, 48. Body line height about 1.5, headings 1.1 to 1.2, 60 to 75 characters per line.
5. Spacing on a 4 or 8px scale, one radius family, one shadow style (or none).
6. The signature: one specific, memorable detail that belongs to this product (a shape language, a data visual, an illustration style, a micro-interaction). A gradient is not a signature.
If the project already has a design system or styles, the brief is "extend what exists": read its tokens and components first and use them.

## 2. Content and structure before decoration
- Real copy for this product: specific headings that say what it does, concrete numbers, believable names. No lorem ipsum, no "Welcome to X", no "Unlock the power of", "Seamless", "Revolutionize", "Elevate your".
- Decide each screen's hierarchy: what is read first, second, third. Size, weight, colour and space carry it, not boxes.
- Vary composition between sections: a split layout, a full-bleed band, a list, a table, a quote, a step sequence. Not five rows of three identical cards.
- Data products lead with the data: numbers right-aligned in tabular figures, labelled charts, designed empty and loading states.

## 3. Craft rules
- Everything sits on a grid. Equal gaps for equal relationships; more space between groups than within them.
- Left-align body text; centre only short, isolated lines.
- Body text at least 16px on the web; contrast at least 4.5:1 for text and 3:1 for large text and control borders.
- Neutrals do most of the work; the accent marks what is actionable or important, so it appears rarely.
- Icons from one set (lucide, heroicons, phosphor), one stroke weight, sized to the text beside them. Never emoji as interface icons.
- One primary button per view, labelled with a verb ("Start free trial", not "Submit"), with hover, focus, active, disabled and loading states.
- Motion of 150 to 250ms, ease-out, only to explain a change (open, move, appear); honour prefers-reduced-motion.
- Images are real or purposeful (product screenshots, diagrams, one consistent illustration style). With none, design without them rather than with placeholders that look like stock.
- Dark mode uses dark grey surfaces (not pure black), a slightly desaturated accent, and borders instead of heavy shadows.

## 4. The AI-slop tells: remove every one you find
Purple-to-blue or rainbow gradients as the main idea; gradient text in headings; glassmorphism and blurred blobs by default; everything rounded-2xl with a large soft shadow; three feature cards with emoji or generic icons; everything centred; a giant hero with a vague tagline; fake logos, testimonials and metrics presented as real; default Tailwind blue or indigo as the brand colour; one font at one weight with no hierarchy; links to "#" and buttons that do nothing; forms that go nowhere; a navbar that breaks or vanishes on mobile.

## 5. Working UX, not a picture of it
- Every flow works end to end: links navigate, buttons do what they say, forms validate with clear messages and confirm success.
- Design the states: loading (skeletons shaped like the content), empty and first use, no results, error with a way out, success.
- Keyboard: everything reachable with Tab in a sensible order, a visible focus ring, Escape closes overlays. Touch targets at least 44px.
- Long names, long words and missing data do not break the layout.

## 6. Build it to last
Semantic HTML (header, nav, main, section, button, label). Flex and grid for layout, not absolute positioning or magic numbers. Colour, type and spacing as CSS variables or the framework's theme, so they come from one place. Mobile first, and nothing overflows sideways.

## 7. Look at it, then fix it (required)
Run it and look at 375, 768 and 1440px wide: browser_batch with resize, open and screenshot steps, and browser_console_logs for errors. Click through the main flow. Fix the worst problem first (broken layout, unreadable text, a dead control, a missing state), then the next. A UI you have not looked at is not done. references/review.md has the full pass and the common fixes.

## Frontend anti-slop gate
Before calling it done, every answer is yes:
- Would someone recognise this as made for this product and audience, not a template?
- Does the brief's direction show, and does the palette have a reason?
- Is the hierarchy clear without oversized text or decorative gradients?
- Is every AI-slop tell from section 4 gone?
- Do all links, buttons and forms work, with loading, empty, error and success states?
- Does it hold up at 375, 768 and 1440px with no sideways scroll, and with long or missing content?
- Are keyboard use, focus, contrast, touch targets and reduced motion handled?
- Is there one memorable, purposeful detail?
If any answer is no, fix that before polishing anything else.`.trim(),
};

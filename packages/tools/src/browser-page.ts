/**
 * What is on the page, and how to point at it.
 *
 * ## The reason browser testing did not work
 *
 * The agent could click, type and hover — by CSS selector. And it had never
 * seen the page: `browser_open` returned a title and a status code, and
 * nothing else. So it guessed. `button.submit`, then `#submit`, then
 * `button[type=submit]`, each one answered by `Timeout 5000ms exceeded`, which
 * says nothing about what *was* there. Three or four rounds of that and the
 * agent concluded it could not test the UI — and reached for `evaluate_js`,
 * which is both the least reliable way to drive a page and a security hole.
 *
 * Guessing was never the problem. Not looking was.
 *
 * ## The snapshot
 *
 * So the page is read first: every interactive element, numbered, with the
 * name a person would use for it.
 *
 * ```
 * [1] button        "Sign in"
 * [2] textbox       "Email address"            (empty)
 * [3] textbox       "Password"                 (empty)
 * [4] link          "Forgot password?"
 * ```
 *
 * The agent then acts on `[2]` rather than on a selector it invented. This is
 * the idea behind browser-use's indexed accessibility tree, and it is the part
 * worth having: the model stops writing selectors and starts naming things it
 * can see.
 *
 * ## Refs, and why they do not need to be stable for ever
 *
 * A ref is valid until the next snapshot, and that is stated where the agent
 * reads it. Each one carries three ways to find its element again — an id or
 * test id, a generated CSS path, and its role plus accessible name — tried in
 * that order, so a re-render that changes the DOM path is usually still
 * resolvable by name. When all three fail the agent is told to take a fresh
 * snapshot, which is a real instruction rather than a timeout.
 *
 * Nothing is written into the page to make this work. Marking elements with a
 * `data-` attribute would be simpler and would also mean the tool changes the
 * DOM of the thing it is supposed to be observing.
 */

/** One element a person could interact with. */
export interface PageElement {
  /** Position in this snapshot. Valid until the next one. */
  ref: number;
  /** `button`, `link`, `textbox`, `checkbox`, `combobox`, … */
  role: string;
  /** What a person would call it: its label, placeholder, or text. */
  name: string;
  /** For a field, what is currently in it. */
  value?: string;
  /** Present and false when the element is disabled. */
  enabled?: boolean;
  /** For a checkbox or radio. */
  checked?: boolean;
  /** Ways to find it again, best first. */
  selectors: string[];
  /** When it is inside a same-origin iframe: a selector for that iframe. */
  frame?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: PageElement[];
  /** The page's visible text, clipped. */
  text: string;
  /** True when the element list was cut at the cap. */
  truncated: boolean;
}

/** Interactive elements in one snapshot. Beyond this a page is a document to
 *  read, not a form to drive, and the list stops being something a model can
 *  hold in its head. */
export const MAX_ELEMENTS = 150;
/** Visible text returned with a snapshot. */
export const MAX_PAGE_TEXT = 6_000;

/**
 * The script that runs inside the page.
 *
 * A string rather than a function, because it is handed to Playwright's
 * `evaluate` and must not close over anything in this module. Everything it
 * needs is passed in — see `snapshotExpression`, which is what callers use.
 *
 * Exported so its output shape can be tested against a real DOM.
 */
export const SNAPSHOT_SCRIPT = `(limits) => {
  const { maxElements, maxText } = limits;

  const INTERACTIVE = [
    "a[href]", "button", "input", "select", "textarea", "summary",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]",
    "[role=tab]", "[role=menuitem]", "[role=option]", "[role=switch]",
    "[role=textbox]", "[role=combobox]", "[role=searchbox]",
    "[contenteditable=true]", "[onclick]",
  ].join(",");

  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (Number(style.opacity) === 0) return false;
    return true;
  };

  const textOf = (el) => (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();

  /*
   * A control the page draws over a hidden input: a styled checkbox or radio
   * whose real input is invisible, or a file input behind a styled button.
   * Left out as invisible, the agreement box of a form could not be ticked
   * by any ref, and was tried by guessed selector after guessed selector
   * (18 Oct 2026). Listed when what stands for it is visible; \`check\` and
   * \`upload\` find their way to the input.
   */
  const standsIn = (el) => {
    if (el.tagName.toLowerCase() !== "input") return false;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "file") return true;
    if (type !== "checkbox" && type !== "radio") return false;
    const holder = (el.labels && el.labels[0]) || el.closest("label") || el.parentElement;
    return Boolean(holder && visible(holder));
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button" || type === "reset") return "button";
      if (type === "range") return "slider";
      if (type === "file") return "file";
      return "textbox";
    }
    if (el.isContentEditable) return "textbox";
    return "generic";
  };

  /* The name a person would use, in the order a screen reader would find it. */
  const nameOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean);
      const joined = parts.map(textOf).join(" ").trim();
      if (joined) return joined;
    }

    if (el.id) {
      const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label) {
        const text = textOf(label);
        if (text) return text;
      }
    }

    const wrapping = el.closest("label");
    if (wrapping) {
      const text = textOf(wrapping);
      if (text) return text;
    }

    const placeholder = el.getAttribute("placeholder");
    if (placeholder && placeholder.trim()) return placeholder.trim();

    if (el.tagName.toLowerCase() === "img" || el.querySelector("img")) {
      const img = el.tagName.toLowerCase() === "img" ? el : el.querySelector("img");
      const alt = img && img.getAttribute("alt");
      if (alt && alt.trim()) return alt.trim();
    }

    const own = textOf(el);
    if (own) return own.slice(0, 120);

    const title = el.getAttribute("title") || "";
    if (title.trim()) return title.trim().slice(0, 120);

    // A box with its words beside it rather than in a label: "I agree to the terms".
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "checkbox" || type === "radio") {
      for (let up = el.parentElement, depth = 0; up && depth < 3; up = up.parentElement, depth++) {
        const near = textOf(up);
        if (near) return near.slice(0, 120);
      }
    }
    return (el.getAttribute("name") || "").trim().slice(0, 120);
  };

  /*
   * A CSS path good enough to find this element again on an unchanged page.
   *
   * Inside a shadow root the path would stop at the root — "button" — which
   * matches every button on the page. So it carries on from the host, joined
   * with a space: Playwright's CSS engine crosses open shadow boundaries on a
   * descendant combinator, so "fancy-button button" names the one inside.
   */
  const pathOf = (el) => {
    const trees = [];
    let target = el;
    for (let depth = 0; target && depth < 4; depth++) {
      const parts = [];
      let node = target;
      while (node && node.nodeType === 1 && parts.length < 6) {
        let part = node.tagName.toLowerCase();
        if (node.id) {
          parts.unshift("#" + CSS.escape(node.id));
          break;
        }
        // Directly under a shadow root, the siblings are the root's children.
        const parent = node.parentElement || (node.parentNode && node.parentNode.host ? node.parentNode : null);
        if (parent) {
          const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
          if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
        }
        parts.unshift(part);
        node = node.parentElement;
      }
      trees.unshift(parts.join(" > "));
      const root = target.getRootNode ? target.getRootNode() : null;
      if (!root || !root.host) break;
      target = root.host;
    }
    return trees.join(" ");
  };

  const selectorsFor = (el) => {
    const out = [];
    if (el.id) out.push("#" + CSS.escape(el.id));
    for (const attr of ["data-testid", "data-test-id", "data-test", "name"]) {
      const value = el.getAttribute(attr);
      if (value) out.push("[" + attr + '="' + value.replace(/"/g, '\\\\"') + '"]');
    }
    const path = pathOf(el);
    if (path) out.push(path);
    return out;
  };

  const seen = new Set();
  const elements = [];
  let truncated = false;

  /*
   * Every root the page's controls can live in: the document, each open
   * shadow root (web components put their buttons there), and each
   * same-origin iframe's document. Searching only the document missed all of
   * them, so an app built from custom elements looked empty.
   */
  const scopes = [];
  const addRoot = (root, frame) => {
    if (scopes.length > 200) return;
    scopes.push({ root: root, frame: frame });
    for (const host of root.querySelectorAll("*")) {
      if (host.shadowRoot) addRoot(host.shadowRoot, frame);
    }
  };
  addRoot(document, undefined);
  for (const iframe of Array.from(document.querySelectorAll("iframe")).slice(0, 5)) {
    try {
      if (iframe.contentDocument && iframe.contentDocument.body) addRoot(iframe.contentDocument, pathOf(iframe));
    } catch (e) {
      /* cross-origin: not ours to read */
    }
  }

  const candidates = [];
  for (const scope of scopes) {
    for (const el of scope.root.querySelectorAll(INTERACTIVE)) candidates.push({ el: el, frame: scope.frame });
  }

  for (const { el, frame } of candidates) {
    if (elements.length >= maxElements) { truncated = true; break; }
    if (seen.has(el) || !(visible(el) || standsIn(el))) continue;
    seen.add(el);

    const role = roleOf(el);
    const entry = {
      ref: elements.length + 1,
      role: role,
      name: nameOf(el),
      selectors: selectorsFor(el),
    };
    if (frame) entry.frame = frame;

    if ("value" in el && typeof el.value === "string" && role !== "button") {
      entry.value = el.value.slice(0, 200);
    }
    if (el.disabled === true) entry.enabled = false;
    /*
     * Only where being checked is a thing the element can be.
     *
     * Every <input> has a boolean \`checked\`, so a text field reported
     * "unchecked" — a property it does not have, listed beside the ones it
     * does, on most rows of most pages.
     */
    if (role === "checkbox" || role === "radio" || role === "switch") {
      entry.checked = el.checked === true;
    }

    elements.push(entry);
  }

  // A shadow root's text is not in the body's innerText; web components
  // would otherwise be invisible in the page text.
  const shadowText = scopes
    .filter((s) => s.root !== document && s.root.host)
    .map((s) => (s.root.textContent || "").replace(/\\s+/g, " ").trim())
    .filter(Boolean)
    .join("\\n");
  const bodyText = ((document.body && document.body.innerText ? document.body.innerText : "") + (shadowText ? "\\n" + shadowText : ""))
    .replace(/\\n{3,}/g, "\\n\\n")
    .trim();

  return {
    url: location.href,
    title: document.title,
    elements: elements,
    text: bodyText.length > maxText ? bodyText.slice(0, maxText) + "\\n… [page text truncated]" : bodyText,
    truncated: truncated,
  };
}`;

/**
 * The snapshot script, as an expression that calls itself.
 *
 * Playwright evaluates a *string* `pageFunction` as an expression and returns
 * its value — it does not call it, the way Puppeteer does. So handing it a
 * function expression returned the function object, which is not
 * serialisable, which Playwright reports as `undefined`. Every snapshot came
 * back empty and every ref resolved to nothing.
 *
 * Building the call into the string is the fix: the expression now evaluates
 * to the snapshot rather than to the function that would produce one.
 */
export function snapshotExpression(limits: { maxElements: number; maxText: number }): string {
  return `(${SNAPSHOT_SCRIPT})(${JSON.stringify(limits)})`;
}

/**
 * The snapshot as the model reads it.
 *
 * Deliberately not JSON. A hundred elements of `{"ref":1,"role":"button",…}` is
 * mostly punctuation, and the thing the agent has to do with this list — find
 * the row that matches what it wants and read its number — is what a table is
 * for.
 */
/** A URL short enough to read. A `data:` URL is the whole document, and
 *  printing it puts the page's own source in the middle of the description of
 *  that page. */
function shortUrl(url: string): string {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    return `${url.slice(0, comma > 0 ? comma : 32)},… (inline document)`;
  }
  return url.length > 300 ? `${url.slice(0, 300)}…` : url;
}

export function renderSnapshot(snapshot: PageSnapshot): string {
  const lines: string[] = [`Page: ${snapshot.title || "(untitled)"}`, `URL: ${shortUrl(snapshot.url)}`, ""];

  if (snapshot.elements.length === 0) {
    lines.push("No interactive elements are visible on this page.");
  } else {
    lines.push("Interactive elements (use the number as `ref`):");
    for (const el of snapshot.elements) {
      const bits: string[] = [];
      if (el.value !== undefined) bits.push(el.value ? `value: "${el.value}"` : "empty");
      if (el.checked !== undefined) bits.push(el.checked ? "checked" : "unchecked");
      if (el.enabled === false) bits.push("disabled");
      const detail = bits.length > 0 ? `  (${bits.join(", ")})` : "";
      lines.push(`  [${el.ref}] ${el.role.padEnd(9)} ${el.name ? `"${el.name}"` : "(no label)"}${detail}`);
    }
    if (snapshot.truncated) {
      lines.push(`  … the list was cut at ${MAX_ELEMENTS} elements.`);
    }
  }

  if (snapshot.text) {
    lines.push("", "Page text:", snapshot.text);
  }

  return lines.join("\n");
}

/**
 * What to say when an element cannot be found.
 *
 * A Playwright timeout names the selector and nothing else, which leaves the
 * agent guessing again. This names what *is* there, which is the only thing
 * that changes the next action.
 */
export function notFoundMessage(what: string, snapshot: PageSnapshot | null): string {
  const head = `Could not find ${what} on the page.`;
  if (!snapshot || snapshot.elements.length === 0) {
    return `${head} Take a browser_snapshot to see what is there.`;
  }
  const listed = snapshot.elements
    .slice(0, 20)
    .map((el) => `  [${el.ref}] ${el.role} ${el.name ? `"${el.name}"` : "(no label)"}`)
    .join("\n");
  return (
    `${head} What is actually on the page right now:\n${listed}` +
    (snapshot.elements.length > 20 ? `\n  … and ${snapshot.elements.length - 20} more` : "") +
    "\n\nUse one of these numbers as `ref`."
  );
}

// svgDomStub.js — TEST-ONLY minimal DOM/XML stand-in.
//
// Not imported by any production module. node --test runs headless (no
// browser DOM, no jsdom dependency available in this repo), and
// svgFlatten.js / svgSanitize.js are both written to accept an injectable
// document/parser precisely so a stub like this can drive them. This file
// implements just enough of the real DOM surface (Element/Document/
// DOMParser/XMLSerializer method names and shapes) that the exact same
// calls svgFlatten.js and svgSanitize.js make against a real browser
// `document` also work here. It intentionally does NOT implement the full
// DOM/XML spec — only a well-formed-XML subset (no entities beyond the
// five predefined ones, no CDATA, no processing instructions besides a
// leading `<?xml ... ?>`, attribute lookups are case-insensitive where the
// real spec is case-sensitive for XML documents). That's fine here: every
// fixture below is hand-written well-formed SVG using lowercase attributes,
// which is what real-world exporters (Illustrator/Inkscape/Figma) emit.

export const SVG_NS = 'http://www.w3.org/2000/svg';

export class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.localName = tagName.replace(/^[^:]+:/, '').toLowerCase();
    this._attrs = [];
    this.childNodes = [];
    this.parentElement = null;
    this.ownerDocument = null;
  }

  get children() {
    return this.childNodes;
  }

  get attributes() {
    // Real NamedNodeMap is iterable and holds live Attr nodes; a plain array
    // of {name,value} objects satisfies every call site in this repo
    // ([...el.attributes], for...of, .length).
    return this._attrs.slice();
  }

  getAttribute(name) {
    const found = this._attrs.find(a => a.name.toLowerCase() === String(name).toLowerCase());
    return found ? found.value : null;
  }

  setAttribute(name, value) {
    const key = String(name).toLowerCase();
    const existing = this._attrs.find(a => a.name.toLowerCase() === key);
    if (existing) existing.value = String(value);
    else this._attrs.push({ name: String(name), value: String(value) });
  }

  removeAttribute(name) {
    const key = String(name).toLowerCase();
    this._attrs = this._attrs.filter(a => a.name.toLowerCase() !== key);
  }

  removeAttributeNode(attr) {
    this._attrs = this._attrs.filter(a => a !== attr);
  }

  hasAttribute(name) {
    const key = String(name).toLowerCase();
    return this._attrs.some(a => a.name.toLowerCase() === key);
  }

  appendChild(child) {
    if (child.parentElement) child.parentElement.removeChild(child);
    child.parentElement = this;
    child.ownerDocument = this.ownerDocument;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child) {
    this.childNodes = this.childNodes.filter(c => c !== child);
    if (child.parentElement === this) child.parentElement = null;
    return child;
  }

  replaceChild(newChild, oldChild) {
    const idx = this.childNodes.indexOf(oldChild);
    if (idx === -1) throw new Error('svgDomStub: replaceChild — oldChild is not a child of this node');
    this.childNodes[idx] = newChild;
    newChild.parentElement = this;
    newChild.ownerDocument = this.ownerDocument;
    oldChild.parentElement = null;
    return oldChild;
  }

  remove() {
    if (this.parentElement) this.parentElement.removeChild(this);
  }

  cloneNode(deep) {
    const clone = new FakeElement(this.tagName);
    clone.ownerDocument = this.ownerDocument;
    clone._attrs = this._attrs.map(a => ({ ...a }));
    if (deep) {
      for (const child of this.childNodes) clone.appendChild(child.cloneNode(true));
    }
    return clone;
  }

  querySelectorAll(sel) {
    const out = [];
    const matches = sel === '*' ? () => true : (el) => el.localName === sel.toLowerCase();
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (matches(child)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
}

export class FakeDocument {
  constructor(root) {
    this.documentElement = root || null;
    if (root) root.ownerDocument = this;
  }

  createElementNS(_ns, tag) {
    const el = new FakeElement(tag);
    el.ownerDocument = this;
    return el;
  }

  createElement(tag) {
    return this.createElementNS(SVG_NS, tag);
  }

  querySelector(sel) {
    // A real Document's querySelector searches the documentElement AND its
    // descendants (documentElement is itself part of the document's tree),
    // unlike Element.querySelector which only searches descendants of the
    // calling element. Check the root itself before delegating downward.
    if (!this.documentElement) return null;
    if (this.documentElement.localName === String(sel).toLowerCase()) return this.documentElement;
    return this.documentElement.querySelector(sel);
  }
}

// ── Minimal well-formed-XML parser (test fixtures only) ─────────────────────

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(str) {
  return str.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.hasOwn(ENTITIES, body) ? ENTITIES[body] : m;
  });
}

function parseXml(source) {
  const str = String(source)
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');
  let i = 0;

  function skipWs() {
    while (i < str.length && /\s/.test(str[i])) i += 1;
  }

  function parseElement() {
    if (str[i] !== '<') throw new Error('expected <');
    i += 1;
    const nameMatch = /^[A-Za-z_][\w:.-]*/.exec(str.slice(i));
    if (!nameMatch) throw new Error('expected element name');
    const el = new FakeElement(nameMatch[0]);
    i += nameMatch[0].length;

    while (true) {
      skipWs();
      if (str.startsWith('/>', i)) { i += 2; return el; }
      if (str[i] === '>') { i += 1; break; }
      const attrMatch = /^[A-Za-z_:][\w:.-]*/.exec(str.slice(i));
      if (!attrMatch) throw new Error('expected attribute or closing bracket');
      const attrName = attrMatch[0];
      i += attrName.length;
      skipWs();
      if (str[i] !== '=') throw new Error('expected = after attribute name');
      i += 1;
      skipWs();
      const quote = str[i];
      if (quote !== '"' && quote !== "'") throw new Error('expected quoted attribute value');
      i += 1;
      const end = str.indexOf(quote, i);
      if (end === -1) throw new Error('unterminated attribute value');
      el.setAttribute(attrName, decodeEntities(str.slice(i, end)));
      i = end + 1;
    }

    while (true) {
      if (i >= str.length) throw new Error(`unterminated element <${el.tagName}>`);
      if (str.startsWith('</', i)) {
        i += 2;
        const closeMatch = /^[A-Za-z_][\w:.-]*/.exec(str.slice(i));
        i += closeMatch ? closeMatch[0].length : 0;
        skipWs();
        if (str[i] === '>') i += 1;
        return el;
      }
      if (str[i] === '<') {
        el.appendChild(parseElement());
      } else {
        const next = str.indexOf('<', i);
        i = next === -1 ? str.length : next;
      }
    }
  }

  skipWs();
  if (str[i] !== '<') return { root: null, parseError: true };
  try {
    const root = parseElement();
    return { root, parseError: false };
  } catch {
    return { root: null, parseError: true };
  }
}

export class FakeDOMParser {
  parseFromString(source) {
    const { root, parseError } = parseXml(source);
    if (parseError || !root) {
      const errRoot = new FakeElement('parsererror');
      const doc = new FakeDocument(errRoot);
      return doc;
    }
    return new FakeDocument(root);
  }
}

function escapeAttrValue(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export class FakeXMLSerializer {
  serializeToString(el) {
    const attrs = el.attributes.map(a => ` ${a.name}="${escapeAttrValue(a.value)}"`).join('');
    if (!el.children.length) return `<${el.tagName}${attrs}/>`;
    const inner = el.children.map(c => this.serializeToString(c)).join('');
    return `<${el.tagName}${attrs}>${inner}</${el.tagName}>`;
  }
}

// Convenience: a documentImpl shaped exactly like sanitizeSvgSource/
// flattenSvgDocument expect (`documentImpl.defaultView.{DOMParser,XMLSerializer}`).
export function makeFakeDocumentImpl() {
  return { defaultView: { DOMParser: FakeDOMParser, XMLSerializer: FakeXMLSerializer } };
}

// Convenience for svgFlatten tests that want to build a tree by hand rather
// than parsing text: makeElement('g', {id:'a'}, [child1, child2]).
export function makeElement(tag, attrs = {}, children = []) {
  const el = new FakeElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const child of children) el.appendChild(child);
  return el;
}

export function makeDocFromRoot(root) {
  return new FakeDocument(root);
}

// Song and episode lists draw only the rows near the viewport. The browser pays for
// every row it holds, shown or not: "Nicht bewertet" at 7500 songs was 300k elements,
// and a play/pause on it took 0.47 s in Firefox (2026-10-26). Two spacers stand in
// for the rest, so the scrollbar still covers the whole list.
//
// The data stays whole - the list hands out the rows, not the songs, so "Abspielen",
// "Mischen" and a download still see every track. A view builds its markup as a
// string, so `register` keeps the data until `mount` finds the list in the DOM.

const OVERSCAN = 12;
// The window moves in steps of this many rows, so a scroll redraws once a block.
const BLOCK = 16;
// Measured on the first row drawn and then remembered per kind; this is only the
// guess for the very first list, and every row in Sonorus measured 56 px.
const GUESS = 56;

const pending = new Map();
const lists = new Set();
const rowHeights = new Map();
let nextId = 0;
let scroller = null;
let decorate = () => {};

// `row(item, index)` returns one row's markup; `fields(item)` the texts Ctrl+F
// searches; `paint(root)` finishes rows the markup alone cannot (a progress width).
export function register(kind, items, { row, fields, paint = null }) {
  nextId += 1;
  pending.set(String(nextId), { kind, items, row, fields, paint });
  return nextId;
}

// Called once at boot: the element that scrolls, and what every freshly drawn
// row needs from outside (the playing marker).
export function setup(scrollEl, decorateRows) {
  scroller = scrollEl;
  decorate = decorateRows;
  scroller.addEventListener('scroll', () => update(), { passive: true });
  new ResizeObserver(() => update()).observe(scroller);
}

export function mount(root) {
  for (const el of root.querySelectorAll('[data-vlist]')) {
    if (el.vlist) continue;
    const spec = pending.get(el.dataset.vlist);
    if (!spec) continue;
    const list = new List(el, spec);
    el.vlist = list;
    lists.add(list);
  }
  // A render that lost the race built a list nobody will show.
  pending.clear();
  update();
}

// The lists on the page, top to bottom.
export function listsIn(root) {
  return [...root.querySelectorAll('[data-vlist]')].map((el) => el.vlist).filter(Boolean);
}

export function update() {
  for (const list of lists) {
    if (list.el.isConnected) list.draw();
    else lists.delete(list);
  }
}

class List {
  constructor(el, spec) {
    this.el = el;
    this.spec = spec;
    // Positions to item indices while Ctrl+F narrows the list; null is all of it.
    this.order = null;
    this.from = 0;
    this.to = 0;
    this.rowH = rowHeights.get(spec.kind) || GUESS;
    const pads = el.querySelectorAll(':scope > .vl-pad');
    this.top = pads[0];
    this.bottom = pads[1];
    // Sized before anything reads the layout, so a restored scroll position
    // has the room it needs before the browser can clamp it.
    this.pad();
  }

  get count() {
    return this.order ? this.order.length : this.spec.items.length;
  }

  get items() {
    return this.spec.items;
  }

  fields(item) {
    return this.spec.fields(item);
  }

  setOrder(order) {
    this.order = order;
    this.clear();
    // Before draw() reads the layout: with the rows gone and the spacers still
    // sized for the old order, Chromium would clamp the scroll position.
    this.pad();
    this.draw();
  }

  html(from, to) {
    let out = '';
    for (let pos = from; pos < to; pos += 1) {
      const i = this.order ? this.order[pos] : pos;
      out += this.spec.row(this.spec.items[i], i);
    }
    return out;
  }

  pad() {
    this.top.style.height = `${this.from * this.rowH}px`;
    this.bottom.style.height = `${(this.count - this.to) * this.rowH}px`;
  }

  // A row being dragged must stay in the document, or its dragend never reaches
  // the listener on #content. It waits out of sight behind the list instead.
  drop(row) {
    if (row.classList.contains('dragging')) {
      row.hidden = true;
      this.el.append(row);
    } else {
      row.remove();
    }
  }

  clear() {
    while (this.top.nextElementSibling !== this.bottom) this.drop(this.top.nextElementSibling);
    this.from = 0;
    this.to = 0;
  }

  // The real height of a row, taken from the first one drawn. It changes with a
  // breakpoint, a zoom or the font size, so it is read on every draw.
  measure() {
    const first = this.top.nextElementSibling;
    if (first === this.bottom) return false;
    const h = first.getBoundingClientRect().height;
    if (!(h > 0) || Math.abs(h - this.rowH) <= 0.5) return false;
    this.rowH = h;
    rowHeights.set(this.spec.kind, h);
    this.pad();
    return true;
  }

  range() {
    const view = scroller.getBoundingClientRect();
    // How far the start of the list lies above the top of the viewport.
    const above = view.top - this.top.getBoundingClientRect().top;
    const from = Math.floor(above / this.rowH) - OVERSCAN;
    const to = Math.ceil((above + scroller.clientHeight) / this.rowH) + OVERSCAN;
    // Clamped at both ends: a list scrolled past lies entirely above the viewport.
    const start = Math.min(this.count, Math.max(0, Math.floor(from / BLOCK) * BLOCK));
    return [start, Math.min(this.count, Math.max(start, Math.ceil(to / BLOCK) * BLOCK))];
  }

  draw() {
    this.measure();
    const [from, to] = this.range();
    if (from === this.from && to === this.to) return;
    this.render(from, to);
    // The first rows of a list are the first chance to measure one.
    if (this.measure()) this.render(...this.range());
    if (this.spec.paint) this.spec.paint(this.el);
    decorate(this.el);
  }

  render(from, to) {
    if (from === this.from && to === this.to) return;
    if (to <= this.from || from >= this.to) {
      this.clear();
      this.bottom.insertAdjacentHTML('beforebegin', this.html(from, to));
    } else {
      for (let pos = this.from; pos < from; pos += 1) this.drop(this.top.nextElementSibling);
      for (let pos = to; pos < this.to; pos += 1) this.drop(this.bottom.previousElementSibling);
      if (from < this.from) this.top.insertAdjacentHTML('afterend', this.html(from, this.from));
      if (to > this.to) this.bottom.insertAdjacentHTML('beforebegin', this.html(this.to, to));
    }
    this.from = from;
    this.to = to;
    this.pad();
  }
}

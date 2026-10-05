// Shared by the player and `/api/shuffle`, so it lives under public/: the browser imports only
// what is served. A fair permutation clumps (half the songs by one interpret: ~76 repeats in
// 300), so the draw stays uniform and only the order spreads each interpret over the list.

/**
 * How far [separate] looks for a swap. A repeat not settled within fifty songs belongs to an
 * interpret owning most of the list, which no order can avoid.
 */
const REACH = 50;

/** Two spellings of the same name are the same interpret for the spread. */
function normalise(key) {
  return String(key ?? '').trim().toLowerCase();
}

/** Fisher-Yates, in place. Returns the same array for chaining. */
export function shuffleInPlace(list, random = Math.random) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/**
 * Hands out slots biggest interpret first: it picks while every slot is free, so it can never
 * follow itself. Even spacing with independent phases alone lets interprets collide and only
 * cut the repeats from 76 to 54.
 */
function dealIntoSlots(groups, total, random) {
  const slots = new Array(total).fill(null);
  // Shuffled first, then sorted by size: `sort` is stable, so interprets who own
  // the same number of songs still come in a random order rather than in
  // whatever order the library happened to list them.
  const ordered = shuffleInPlace([...groups], random).sort((a, b) => b.length - a.length);

  for (const group of ordered) {
    const step = total / group.length;
    const phase = random() * step;
    for (let i = 0; i < group.length; i += 1) {
      let at = Math.floor(phase + i * step) % total;
      while (slots[at] !== null) at = (at + 1) % total;
      slots[at] = group[i];
    }
  }
  return slots;
}

/** How many of the two joins around position [i] are a repeat. */
function joinCost(keys, i) {
  let cost = 0;
  if (i > 0 && keys[i] === keys[i - 1]) cost += 1;
  if (i < keys.length - 1 && keys[i] === keys[i + 1]) cost += 1;
  return cost;
}

/**
 * Trades away the few repeats the slot deal leaves (two interprets wanting one slot), in one
 * pass: only swaps that lower the repeat count are kept, so it never makes the list worse.
 */
function separate(order, keys) {
  for (let i = 1; i < order.length; i += 1) {
    if (keys[i] !== keys[i - 1]) continue;
    const until = Math.min(order.length, i + 1 + REACH);
    // From i + 2, so the two positions never share a join and the cost of each can
    // be read on its own.
    for (let j = i + 2; j < until; j += 1) {
      const before = joinCost(keys, i) + joinCost(keys, j);
      [keys[i], keys[j]] = [keys[j], keys[i]];
      if (joinCost(keys, i) + joinCost(keys, j) < before) {
        [order[i], order[j]] = [order[j], order[i]];
        break;
      }
      [keys[i], keys[j]] = [keys[j], keys[i]];
    }
  }
  return order;
}

/**
 * Spreads each interpret over the list instead of only permuting it. [keyOf] gives an item's
 * interpret (items may be tracks or queue positions). `avoid` is the interpret the list must not
 * open with: the clicked track stays in front, and its own name straight after it is a repeat.
 */
export function spreadByArtist(items, keyOf, { random = Math.random, avoid = null } = {}) {
  const list = [...items];
  if (list.length < 3) return shuffleInPlace(list, random);

  const groups = new Map();
  for (const item of list) {
    const key = normalise(keyOf(item));
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  for (const group of groups.values()) shuffleInPlace(group, random);

  const order = dealIntoSlots([...groups.values()], list.length, random);
  const keys = order.map((item) => normalise(keyOf(item)));
  separate(order, keys);

  const head = normalise(avoid);
  if (head && keys[0] === head) {
    const other = keys.findIndex((key) => key !== head);
    if (other > 0) [order[0], order[other]] = [order[other], order[0]];
  }
  return order;
}

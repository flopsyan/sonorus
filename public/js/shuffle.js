// The shuffle, and the one module both halves of Sonorus run.
//
// It lives under `public/` rather than under `src/lib/` because the browser can
// only import what is served, and the server can import anything: the player in
// the browser and `/api/shuffle` on the server have to deal the same way, and a
// second copy of this file is a copy that would drift.
//
// ## Why a correct shuffle needed fixing at all
//
// Nothing here was broken in the maths. `ORDER BY RANDOM()` draws a uniform
// sample and Fisher-Yates produces a uniform permutation - both were right all
// along. What they are not is what "shuffled" is expected to *sound* like, and
// for one concrete reason:
//
// **A fair permutation clumps.** Songs by the same interpret land next to each
// other far more often than anyone expects - the same effect that makes people
// call true random "not random". On a pool of 300 songs, half of them by one
// interpret, a plain Fisher-Yates leaves about 76 places where that name follows
// itself, with runs of a dozen in a row. Nothing is wrong with it; it simply
// sounds like the shuffle is stuck.
//
// The draw itself is deliberately left alone: every *song* stays equally likely,
// so a random run keeps sounding like the library actually is. Only the order
// changes, and the idea is the one Spotify described in 2014 - do not order the
// songs, order the *interprets*, each one laid out evenly across the whole list
// so two songs by the same name are always about a list-length divided by their
// count apart.
//
// For a list with one interpret in it - an album, a single artist's page - every
// song is in the same group and the result is a plain shuffle again. The spread
// costs nothing where there is nothing to spread.

/**
 * How far [separate] looks for a song to trade places with.
 *
 * A repeat that cannot be settled inside fifty songs is one where that interpret
 * owns most of the list, and then no order avoids it - so the search stops
 * rather than walking the whole tail for nothing.
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
 * Lays every interpret out over the whole list, biggest first.
 *
 * Biggest first is the whole trick, and it is what an earlier attempt at this
 * got wrong. Giving each interpret an even spacing but an *independent* random
 * starting point spreads each of them correctly and still lets two of them land
 * on the same spot: with one name owning half the list, about a third of its
 * slots collide with something and the repeats only fall from 76 to 54.
 *
 * Handing out the slots instead settles that by construction. The interpret with
 * the most songs picks while every slot is still free, so it takes every second
 * one and can no longer follow itself at all; everyone else fills in around it.
 * A song whose slot is taken moves to the next free one along, which is close
 * enough that the even spread survives.
 *
 * The starting point stays random, so the same library deals a different order
 * every time.
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

/**
 * How many of the two joins around position [i] are a repeat.
 *
 * The measure [separate] works on: a swap is worth making when it leaves fewer
 * of these behind than it found.
 */
function joinCost(keys, i) {
  let cost = 0;
  if (i > 0 && keys[i] === keys[i - 1]) cost += 1;
  if (i < keys.length - 1 && keys[i] === keys[i + 1]) cost += 1;
  return cost;
}

/**
 * Trades the last neighbouring repeats away, one pass, in place.
 *
 * The slot deal leaves few of them - they are what the "next free slot along"
 * rule produces when two interprets want the same place. This settles those: a
 * song sitting next to its own name trades places with the nearest later song
 * that is happier there. Only swaps that really lower the count are kept, so the
 * pass can never make the list worse.
 */
function separate(order, keys) {
  for (let i = 1; i < order.length; i += 1) {
    if (keys[i] !== keys[i - 1]) continue;
    const until = Math.min(order.length, i + 1 + REACH);
    // From i + 2, so the two positions never share a neighbour and the cost of
    // each can be read on its own.
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
 * A shuffle that spreads each interpret over the whole list instead of only
 * permuting it. See the note at the top of this file for what that buys.
 *
 * [keyOf] says what an item's interpret is - the items themselves may be tracks
 * or positions into a queue, which is why this never reaches into them.
 *
 * `avoid` is the interpret the list must not *open* with. The one repeat the
 * spread cannot see is the song already in front of the list: the track that was
 * clicked stays first, and its own name coming straight after it is exactly what
 * this is here to prevent.
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

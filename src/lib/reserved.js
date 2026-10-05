// Look-alikes written for characters a file name cannot carry ("AC∕DC" for "AC/DC"),
// mapped back to the meant name. Escapes on purpose: an editor shows no difference.
const LOOKALIKES = {
  '/': '\u2215\u2044\u29f8\u2571\u27cb',
  '\\': '\u2216\u29f5\u29f9\ufe68\u2572\u27cd',
  ':': '\ua789\u2236\u02d0\ufe55\ua4fd',
  '?': '\ufe56',
  '*': '\u2217\u204e\ufe61',
  '"': '\u2033\u02ba',
  '<': '\u02c2\u1438\ufe64',
  '>': '\u02c3\u1433\ufe65',
  '|': '\u01c0\u2223\u2502\u23d0\u2758',
};

const REAL = new Map();
for (const [real, alikes] of Object.entries(LOOKALIKES)) {
  for (const ch of alikes) REAL.set(ch, real);
}
const ALIKE = new RegExp(`[${[...REAL.keys()].join('')}]`, 'g');

// The fullwidth forms of the same nine are ordinary punctuation in Japanese and
// Chinese, so a run of them stays where it touches that script or another
// fullwidth character.
const CJK = '\\u2e80-\\u2fdf\\u3000-\\u30ff\\u31f0-\\u31ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef\\u{20000}-\\u{2fa1f}';
const FULLWIDTH = new RegExp(
  `(?<![${CJK}])[\\uff02\\uff0a\\uff0f\\uff1a\\uff1c\\uff1e\\uff1f\\uff3c\\uff5c]+(?![${CJK}])`,
  'gu'
);

export function restoreReserved(name) {
  return String(name)
    .replace(ALIKE, (ch) => REAL.get(ch))
    .replace(FULLWIDTH, (run) =>
      run.replace(/./g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    );
}

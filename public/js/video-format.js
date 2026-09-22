// Words for the video side that more than one module needs.

// ffprobe hands out ISO 639-2 (bibliographic or terminology), subtitle files
// ISO 639-1; Intl only names the short forms reliably.
const LONG_TO_SHORT = {
  ger: 'de', deu: 'de', eng: 'en', fre: 'fr', fra: 'fr', spa: 'es', ita: 'it', jpn: 'ja',
  hin: 'hi', dut: 'nl', nld: 'nl', ara: 'ar', ind: 'id', por: 'pt', swe: 'sv', may: 'ms',
  msa: 'ms', chi: 'zh', zho: 'zh', kor: 'ko', rus: 'ru', pol: 'pl', tur: 'tr', dan: 'da',
  nor: 'no', nob: 'nb', fin: 'fi', gre: 'el', ell: 'el', heb: 'he', hun: 'hu', cze: 'cs',
  ces: 'cs', tha: 'th', vie: 'vi', ukr: 'uk', rum: 'ro', ron: 'ro', tam: 'ta', tel: 'te',
};

let names = null;
try {
  names = new Intl.DisplayNames(['de'], { type: 'language' });
} catch {
  names = null;
}

export function langName(code) {
  const raw = String(code || '').toLowerCase();
  if (!raw || raw === 'und' || raw === 'zxx' || raw === 'mul') return '';
  const short = LONG_TO_SHORT[raw] || raw;
  try {
    const name = names && names.of(short);
    if (name && name.toLowerCase() !== short) return name;
  } catch {
    // unknown code
  }
  return raw.toUpperCase();
}

const CODECS = { aac: 'AAC', ac3: 'Dolby Digital', eac3: 'Dolby Digital+', dts: 'DTS', truehd: 'TrueHD', mp3: 'MP3', opus: 'Opus', flac: 'FLAC', vorbis: 'Vorbis' };
const CHANNELS = { 1: 'Mono', 2: 'Stereo', 6: '5.1', 8: '7.1' };

// Release groups write their domain into every track title; that is not a name.
const junkTitle = (t) => /\.[a-z]{2,6}\b|www|https?:/i.test(t || '');

export function audioLabel(a) {
  const parts = [langName(a.lang) || 'Unbekannt'];
  if (a.title && !junkTitle(a.title) && a.title.length < 40) parts.push(a.title);
  const tech = [CODECS[a.codec] || String(a.codec || '').toUpperCase(), CHANNELS[a.channels] || (a.channels ? `${a.channels} Kanäle` : '')]
    .filter(Boolean)
    .join(' ');
  return { main: parts.join(' · '), sub: tech };
}

export function subtitleLabel(s) {
  const parts = [langName(s.lang) || 'Unbekannt'];
  if (s.forced) parts.push('erzwungen');
  if (s.sdh) parts.push('für Hörgeschädigte');
  if (s.title && !junkTitle(s.title) && s.title.length < 40 && !s.forced) parts.push(s.title);
  return parts.join(' · ');
}

/** "FSK 16" for a German rating, the plain rating for anything else. */
export function certLabel(value) {
  if (!value) return '';
  const [country, rating] = String(value).split(':');
  if (!rating) return value;
  return country === 'DE' ? `FSK ${rating}` : rating;
}

/** "S2 · E5", "S2 · E5-6", "Special". */
export function episodeCode(season, episode, episodeEnd) {
  if (season === 0) return episode != null ? `Special ${episode}` : 'Special';
  if (episode == null) return `S${season}`;
  return `S${season} · E${episode}${episodeEnd ? `-${episodeEnd}` : ''}`;
}

export function videoCodecLabel(codec) {
  return { h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', mpeg2video: 'MPEG-2', mpeg4: 'MPEG-4' }[codec] || String(codec || '').toUpperCase();
}

export function resolutionLabel(height, width) {
  if (!height) return '';
  if (height >= 1500 || width >= 3000) return '4K';
  if (height >= 1000 || width >= 1900) return '1080p';
  if (height >= 700 || width >= 1260) return '720p';
  return `${height}p`;
}

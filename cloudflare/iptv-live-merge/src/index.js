const SOURCES = [
  {
    url: 'https://raw.githubusercontent.com/dungntk9/Iptv/main/SuperOK_playlist.m3u',
    groups: new Set(['VTV', 'VTVcab', 'SCTV', 'HTV', 'Sự Kiện FPT PLAY', 'Thiết yếu', '🇸🇬 Mediacorp', '🌟SPORTS VIP🌟'])
  },
  {
    url: 'https://raw.githubusercontent.com/vuminhthanh12/vuminhthanh12/refs/heads/main/vmttv',
    groups: new Set(['Sự Kiện TV360'])
  },
  {
    url: 'https://tinyurl.com/ttthethao2',
    groups: new Set(['Giờ Vàng TV', 'Gà Vàng 33 TV', 'Xôi Lạc Z TV', 'Gà Vàng TV'])
  },
  {
    url: 'https://raw.githubusercontent.com/dungntk9/Iptv-phuongnm7/main/VIP-307.m3u',
    groups: new Set([
      'VIP | 4K ULTRA HD',
      'VIP | PREMIER LEAGUE',
      'VIP | LA LIGA',
      'VIP | BUNDESLIGA',
      'VIP | UEFA CHAMPIONS LEAGUE',
      '┃UK┃ EPL PREMIER LEAGUE TEAMS'
    ])
  }
];

function groupOf(extinf) {
  const m = extinf.match(/group-title="([^"]*)"/i);
  return m ? m[1].replace(/\\u00a0/g, ' ').trim() : '';
}

function entries(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const result = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      if (current) result.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) result.push(current);
  return result;
}

async function fetchSource(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 IPTV dynamic playlist' },
    cf: { cacheTtl: 0, cacheEverything: false }
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

export default {
  async fetch(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const selected = [];
    const seen = new Set();
    const errors = [];

    for (const source of SOURCES) {
      try {
        const text = await fetchSource(source.url);
        for (const entry of entries(text)) {
          const group = groupOf(entry[0]);
          if (!source.groups.has(group)) continue;
          const stream = [...entry].reverse().find(line => line.trim() && !line.startsWith('#'))?.trim() || '';
          const key = `${group}\n${stream}\n${entry[0]}`;
          if (seen.has(key)) continue;
          seen.add(key);
          selected.push(entry);
        }
      } catch (error) {
        errors.push(`${source.url}: ${error.message}`);
      }
    }

    if (!selected.length) {
      return new Response('No matching channels were found. ' + errors.join(' | '), {
        status: 502,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }

    const output = [
      '#EXTM3U x-tvg-url=""',
      '#PLAYLIST: NM7 - Dynamic Selected IPTV',
      '# Generated on every request from configured source playlists.'
    ];
    for (const entry of selected) output.push(...entry);

    if (errors.length) output.push('# WARNING: ' + errors.join(' | '));

    const body = output.join('\n') + '\n';
    return new Response(request.method === 'HEAD' ? null : body, {
      status: 200,
      headers: {
        'Content-Type': 'application/x-mpegURL; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
};

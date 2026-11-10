/*
 * BestImage resolver
 * ---------------------------------------------------------------------------
 * Pure URL logic. No DOM, no chrome.* APIs, so the same file runs in:
 *   - the content script (page)
 *   - the MV3 service worker (importScripts)
 *   - Node unit tests
 *
 * The goal is not "guess every CDN", but to be right on the big sites and to
 * stay conservative everywhere else.  A wrong guess is worse than no guess:
 * it opens a broken image tab.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BestImage = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '1.0.5';

  const DEFAULT_SETTINGS = {
    enabled: true,
    unblock: true,
    proxy: true,
    referer: true,
    rewrite: false,
    toast: false,
    openInBackground: false,
    disabledSites: [],
  };

  const IMAGE_EXT_RE = /\.(?:jpe?g|png|gif|webp|avif|bmp|svg|tiff?|jfif|heic|ico)(?:[?#]|$)/i;

  // Weibo image sizes, best -> worst.  "oslarge" is the current no-watermark
  // original endpoint; "woriginal" and "large" are kept as fallbacks for old
  // posts.  Values are only used for ordering.
  const WEIBO_SIZES = {
    oslarge: 100,
    woriginal: 95,
    large: 90,
    mw2000: 80,
    orj1080: 70,
    mw1024: 60,
    mw690: 50,
    bmiddle: 40,
    orj360: 30,
    wap360: 25,
    wap180: 15,
    small: 20,
    thumbnail: 10,
    thumb150: 10,
    thumb300: 10,
    square: 5,
  };

  // Query parameters that almost always mean "resize / recompress this image".
  // They are only removed when the URL does not look signed.
  const TRANSFORM_KEYS = new Set([
    'x-oss-process',
    'x-oss-image',
    'imageview2',
    'imagemogr2',
    'image_process',
    'imageprocess',
    'imageslim',
    'thumbnail',
    'thumb',
    'resize',
    'compress',
    'quality',
    'q',
    'w',
    'width',
    'h',
    'height',
    'maxwidth',
    'maxheight',
    'max-width',
    'max-height',
    'fit',
    'crop',
    'size',
    'scale',
    'dpr',
    'sampling',
    'interlace',
    'strip',
  ]);

  // If any of these are present the URL is signed; changing it (or its query)
  // will normally return 403, so leave it alone.
  const SIGNATURE_KEYS = new Set([
    'x-amz-signature',
    'x-amz-credential',
    'x-amz-security-token',
    'signature',
    'sig',
    'token',
    'expires',
    'auth',
    'authorization',
    'jwt',
    'policy',
    'key-pair-id',
    'se',
    'sp',
    'sv',
  ]);

  function absUrl(value, base) {
    if (value == null) return null;
    let s = String(value).trim();
    if (!s) return null;
    s = s.replace(/^['"]|['"]$/g, '').replace(/&amp;/g, '&');
    if (/^data:image\//i.test(s)) return s;
    try {
      return base ? new URL(s, base).href : new URL(s).href;
    } catch (e) {
      return null;
    }
  }

  function parseUrl(value, base) {
    const abs = absUrl(value, base);
    if (!abs || /^data:/i.test(abs)) return null;
    try {
      const u = new URL(abs);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u;
    } catch (e) {
      return null;
    }
  }

  function withPath(u, pathname) {
    const v = new URL(u.href);
    v.pathname = pathname;
    return v.href;
  }

  function matchesHost(host, hosts) {
    const h = String(host || '').toLowerCase();
    return hosts.some((d) => h === d || h.endsWith('.' + d));
  }

  function hasSignature(params) {
    for (const key of params.keys()) {
      if (SIGNATURE_KEYS.has(String(key).toLowerCase())) return true;
    }
    return false;
  }

  function stripTransformSearch(u) {
    const v = new URL(u.href);
    let changed = false;
    if (!hasSignature(v.searchParams)) {
      for (const key of Array.from(v.searchParams.keys())) {
        if (TRANSFORM_KEYS.has(key.toLowerCase())) {
          v.searchParams.delete(key);
          changed = true;
        }
      }
      // CDNs such as Qiniu / Alibaba use a path-like query without "=":
      //   ?imageView2/2/w/1080/format/webp
      const raw = v.search.slice(1);
      if (raw && /^(?:imageView2|imageMogr2|image_process|imageslim|x-oss-process)(?:\/|$)/i.test(raw)) {
        v.search = '';
        changed = true;
      }
    }
    return changed ? v.href : null;
  }

  function genericUpgrade(u) {
    const v = new URL(u.href);
    let changed = false;

    // WordPress resized copies: foo-300x200.jpg -> foo.jpg
    // Only inside wp-content/uploads, otherwise "-300x200" may be a real name.
    if (/\/wp-content\/uploads\//i.test(v.pathname)) {
      const np = v.pathname.replace(/-\d{2,4}x\d{2,4}(\.(?:jpe?g|png|gif|webp|avif))$/i, '$1');
      if (np !== v.pathname) {
        v.pathname = np;
        changed = true;
      }
    }

    if (!hasSignature(v.searchParams)) {
      for (const key of Array.from(v.searchParams.keys())) {
        if (TRANSFORM_KEYS.has(key.toLowerCase())) {
          v.searchParams.delete(key);
          changed = true;
        }
      }
      const raw = v.search.slice(1);
      if (raw && /^(?:imageView2|imageMogr2|image_process|imageslim|x-oss-process)(?:\/|$)/i.test(raw)) {
        v.search = '';
        changed = true;
      }
    }

    return changed ? [v.href] : [];
  }

  const RULES = [
    {
      id: 'weibo',
      hosts: ['sinaimg.cn'],
      run(u) {
        const parts = u.pathname.split('/');
        if (parts.length < 3) return [];
        const size = String(parts[1] || '').toLowerCase();
        const rank = WEIBO_SIZES[size];
        if (!rank) return [];
        return Object.keys(WEIBO_SIZES)
          .filter((name) => WEIBO_SIZES[name] > rank)
          .sort((a, b) => WEIBO_SIZES[b] - WEIBO_SIZES[a])
          .map((name) => withPath(u, '/' + name + '/' + parts.slice(2).join('/')));
      },
    },
    {
      id: 'zhihu',
      hosts: ['zhimg.com'],
      run(u) {
        const re = /_(r|b|xl|hd|qhd|720w|1080w|1440w|2160w|4k)(\.(?:jpe?g|png|gif|webp|avif))$/i;
        const m = u.pathname.match(re);
        if (!m) return [];
        if (m[1].toLowerCase() === 'r') return [];
        return [withPath(u, u.pathname.replace(re, '_r$2'))];
      },
    },
    {
      id: 'bilibili',
      hosts: ['hdslb.com'],
      run(u) {
        // .../archive/xxx.jpg@480w_270h_1c.webp  ->  .../archive/xxx.jpg
        const at = u.pathname.indexOf('@');
        if (at <= 0) return [];
        return [withPath(u, u.pathname.slice(0, at))];
      },
    },
    {
      id: 'taobao',
      hosts: ['alicdn.com'],
      run(u) {
        // O1CN..._!!0-item_pic.jpg_400x400.jpg  /  xxx.jpg_.webp
        const m = u.pathname.match(/^(.*\.(?:jpe?g|png|gif|webp|avif))(_[^/]*)$/i);
        let out = m ? withPath(u, m[1]) : null;
        const cleaned = stripTransformSearch(new URL(out || u.href));
        if (cleaned) out = cleaned;
        return out && out !== u.href ? [out] : [];
      },
    },
    {
      id: 'jd',
      hosts: ['360buyimg.com'],
      run(u) {
        const segs = u.pathname.split('/');
        const first = segs[1] || '';
        let changed = false;
        if (/^n\d+$/i.test(first)) {
          // /n1/s450x450_jfs/t1/...  ->  /n0/jfs/t1/...  (drop the size prefix)
          if (/^s\d+x\d+_jfs$/i.test(segs[2] || '')) {
            segs.splice(1, 2, 'n0', 'jfs');
          } else {
            segs[1] = 'n0';
          }
          changed = true;
        } else if (/^s\d+x\d+_jfs$/i.test(first)) {
          // /s800x800_jfs/t1/...  ->  /n0/jfs/t1/...
          segs.splice(1, 1, 'n0', 'jfs');
          changed = true;
        } else if (/^(?:imgzone|popWaterMark)$/i.test(first) && /^n\d+$/i.test(segs[2] || '')) {
          segs[2] = 'n0';
          if (/^s\d+x\d+_jfs$/i.test(segs[3] || '')) segs[3] = 'jfs';
          changed = true;
        }
        if (!changed) return [];
        return [withPath(u, segs.join('/'))];
      },
    },
    {
      id: 'xiaohongshu',
      hosts: ['xhscdn.com'],
      run(u) {
        // Signed URLs look like
        //   /<stamp>/<sig32>/notes_pre_post/<key>!nc_n_webp_mw_1
        // The style suffix is covered by the signature, so it cannot be
        // edited in place.  The same object is mirrored on sns-img-* with the
        // same path prefix; there the JPEG style returns a full-size JPEG
        // instead of the page's compressed webp preview.
        let p = u.pathname.replace(/^\/\d{8,}\/[0-9a-f]{16,}\//i, '/');
        const segs = p.split('/').filter(Boolean);
        if (!segs.length) return [];
        const key = (segs.pop() || '').split('!')[0];
        if (!/^[0-9a-z]{8,}$/i.test(key)) return [];
        const prefix = segs.length ? segs.join('/') + '/' : '';
        const hw = 'https://sns-img-hw.xhscdn.com/' + prefix + key;
        const bd = 'https://sns-img-bd.xhscdn.com/' + prefix + key;
        return [
          hw + '!nd_dft_wlteh_jpg_1',
          hw,
          bd + '!nd_dft_wlteh_jpg_1',
          bd,
        ].filter((x) => x !== u.href);
      },
    },
    {
      id: 'kuwo',
      hosts: ['kuwo.cn'],
      run(u) {
        // Kuwo album covers commonly use:
        //   /star/albumcover/500/<...>.jpg
        // The same object is available without the size directory on the
        // image CDN; keep a few numbered fallbacks because older objects may
        // not expose the size-less form.
        if (!/^(?:kwimg\d*|img\d+)\.(?:kwcdn\.)?kuwo\.cn$/i.test(u.hostname)) {
          return [];
        }
        const m = u.pathname.match(/^\/star\/albumcover\/(\d{2,4})(\/.*)$/i);
        if (!m) return [];
        const current = Number(m[1]);
        const kind = '/star/albumcover';
        const candidates = [
          withPath(u, kind + m[2]),
          ...[1200, 1000, 800, 500, 300, 200, 150, 130, 100]
            .filter((size) => size > current)
            .slice(0, 2)
            .map((size) => withPath(u, kind + '/' + size + m[2])),
        ];
        return candidates;
      },
    },
    {
      id: 'qqmusic',
      hosts: ['qq.com', 'gtimg.cn'],
      run(u) {
        // QQ Music cover URLs:
        //   /music/photo_new/T002R300x300M000<mid>.jpg
        // Removing R<size>x<size> requests the full source image (often
        // 3000x3000); numbered sizes remain as conservative fallbacks.
        if (!/\/music\/photo_new\//i.test(u.pathname)) return [];
        const m = u.pathname.match(/(\/T\d{3})R(\d{2,5})x(\d{2,5})(M000[^/]+\.(?:jpe?g|png|gif|webp|avif))$/i);
        if (!m) return [];
        const prefix = m[1];
        const suffix = m[4];
        const candidates = [
          withPath(u, u.pathname.replace(m[0], prefix + suffix)),
          ...[1200, 800]
            .map((size) => withPath(u, u.pathname.replace(m[0], prefix + 'R' + size + 'x' + size + suffix))),
        ];
        return candidates;
      },
    },
    {
      id: 'netease',
      hosts: ['music.126.net'],
      run(u) {
        // NetEase Music uses ?param=200y200 (or similar) for cover
        // thumbnails.  The path itself points at the original object.
        if (!u.searchParams.has('param')) return [];
        const v = new URL(u.href);
        v.searchParams.delete('param');
        return [v.href];
      },
    },
    {
      id: 'kugou',
      hosts: ['kugou.com'],
      run(u) {
        // KuGou CDN cover/MV paths commonly use:
        //   /stdmusic/240/<date>/<file>.jpg
        //   /custom/150/<date>/<file>.jpg
        //   /mvhdpic/400/<date>/<file>.jpg
        // The size-less path is the highest-quality form on current CDN
        // objects; numbered sizes are retained as fallbacks.
        if (!/^imgessl\.kugou\.com$/i.test(u.hostname)) return [];
        const m = u.pathname.match(/^\/(stdmusic|custom|fmlogov2|mvhdpic)\/(\d{2,4})(\/.*)$/i);
        if (!m) return [];
        const kind = m[1];
        const current = Number(m[2]);
        const tail = m[3];
        const candidates = [
          withPath(u, '/' + kind + tail),
          ...[1080, 1000, 800, 480, 400, 300, 240, 150, 120]
            .filter((size) => size > current)
            .slice(0, 2)
            .map((size) => withPath(u, '/' + kind + '/' + size + tail)),
        ];
        return candidates;
      },
    },
    {
      id: 'douban',
      hosts: ['doubanio.com'],
      run(u) {
        let p = u.pathname;
        p = p.replace(
          /\/view\/(photo|note|group_topic|subject|status|celebrities|game|music|movie|book)\/(?:s|m)\//,
          '/view/$1/l/'
        );
        p = p.replace(/\/view\/photo\/(?:s|m)_ratio_poster\//, '/view/photo/l_ratio_poster/');
        p = p.replace(/\/view\/photo\/(?:s|m)_ratio\//, '/view/photo/l_ratio/');
        return p !== u.pathname ? [withPath(u, p)] : [];
      },
    },
    {
      id: 'twitter',
      hosts: ['twimg.com'],
      run(u) {
        const p = u.pathname;
        if (/\/(?:media|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb|card_img)\//.test(p)) {
          if (u.searchParams.get('name') === 'orig') return [];
          const v = new URL(u.href);
          v.searchParams.set('name', 'orig');
          return [v.href];
        }
        if (/\/profile_images\//.test(p)) {
          const np = p.replace(/_(?:normal|bigger|mini|400x400|200x200|reasonably_small)(\.(?:jpe?g|png|gif|webp))$/i, '$1');
          return np !== p ? [withPath(u, np)] : [];
        }
        return [];
      },
    },
    {
      id: 'pinterest',
      hosts: ['pinimg.com'],
      run(u) {
        const np = u.pathname.replace(/^\/\d{2,4}x\d{0,4}\//, '/originals/');
        return np !== u.pathname ? [withPath(u, np)] : [];
      },
    },
    {
      id: 'pixiv',
      hosts: ['pximg.net'],
      run(u) {
        let np = u.pathname.replace(/^\/c\/[^/]+\//, '/');
        np = np.replace('/img-master/', '/img-original/');
        np = np.replace(/_(?:master\d+|square1200|1200x1200)(\.(?:jpe?g|png|gif|webp))$/i, '$1');
        return np !== u.pathname ? [withPath(u, np)] : [];
      },
    },
    {
      id: 'wechat',
      hosts: ['qpic.cn'],
      run(u) {
        if (!/^\/(?:mmbiz|sz_mmbiz)(?:_[a-z0-9]+)?\//i.test(u.pathname)) return [];
        const v = new URL(u.href);
        let changed = false;
        const m = u.pathname.match(/^(.*\/)(\d{2,4})$/);
        if (m && Number(m[2]) >= 100 && Number(m[2]) !== 0) {
          v.pathname = m[1] + '0';
          changed = true;
        }
        for (const key of ['wxfrom', 'wx_lazy', 'from', 'tp', 'wx_co', 'scene', 'subscene']) {
          if (v.searchParams.has(key)) {
            v.searchParams.delete(key);
            changed = true;
          }
        }
        return changed ? [v.href] : [];
      },
    },
    {
      id: 'huaban',
      hosts: ['huaban.com', 'huabanimg.com', 'hb.aicdn.com', 'hbimg.b0.upaiyun.com'],
      run(u) {
        // Current pins: /<64hex>-<6char>_fw480webp  (and /format/webp variants)
        // Older pins:   /<hash>_fw658 or /<hash>_sq75
        // Dropping the size suffix yields the original upload.
        const single = /^\/[A-Za-z0-9][A-Za-z0-9_.\-]*(?:\/format\/[a-z0-9]+)?\/?$/i.test(u.pathname);
        if (!single) return [];
        let p = u.pathname.replace(/\/format\/[a-z0-9]+$/i, '');
        p = p.replace(/_(?:fw|sq|ht|hw|thumb)\d*(?:\.?(?:webp|jpe?g|png))?$/i, '');
        let out = p !== u.pathname ? withPath(u, p) : null;
        const cleaned = stripTransformSearch(new URL(out || u.href));
        if (cleaned) out = cleaned;
        return out && out !== u.href ? [out] : [];
      },
    },
    {
      id: 'wikimedia',
      hosts: ['wikimedia.org'],
      run(u) {
        if (!/\/thumb\//.test(u.pathname)) return [];
        const segs = u.pathname.split('/');
        const i = segs.indexOf('thumb');
        if (i < 0) return [];
        segs.splice(i, 1);
        // Drop the ".../220px-Foo.jpg" segment; the original "Foo.jpg"
        // segment immediately before it is the real file name.
        segs.pop();
        const np = segs.join('/');
        if (np === u.pathname) return [];
        const v = new URL(u.href);
        v.pathname = np;
        // Wikipedia now serves thumbnails from thumb.wikimedia.org; the
        // original file lives on upload.wikimedia.org.
        if (v.hostname === 'thumb.wikimedia.org') v.hostname = 'upload.wikimedia.org';
        return [v.href];
      },
    },
    {
      id: 'google',
      hosts: ['googleusercontent.com', 'ggpht.com'],
      run(u) {
        const np = u.pathname.replace(/=[swh]\d+(?:-[a-z0-9]+)*$/i, '=s0');
        return np !== u.pathname ? [withPath(u, np)] : [];
      },
    },
    {
      id: 'imgur',
      hosts: ['imgur.com'],
      run(u) {
        if (u.hostname.toLowerCase() !== 'i.imgur.com') return [];
        const m = u.pathname.match(/^\/([A-Za-z0-9]{5}|[A-Za-z0-9]{7})([sbtmlh])(\.(?:jpe?g|png|gif|webp))$/);
        if (!m) return [];
        return [withPath(u, '/' + m[1] + m[3])];
      },
    },
    {
      id: 'medium',
      hosts: ['medium.com'],
      run(u) {
        let np = u.pathname.replace(/^\/v2\/resize:fit:\d+\//, '/v2/resize:fit:4000/');
        if (np === u.pathname) np = u.pathname.replace(/^\/max\/\d+\//, '/max/4000/');
        return np !== u.pathname ? [withPath(u, np)] : [];
      },
    },
    {
      id: 'substack',
      hosts: ['substackcdn.com'],
      run(u) {
        const m = u.pathname.match(/\/image\/fetch\/[^/]+\/(.+)$/);
        if (!m) return [];
        let inner = m[1];
        try {
          inner = decodeURIComponent(inner);
        } catch (e) {
          /* keep as-is */
        }
        return /^https?:\/\//i.test(inner) ? [inner] : [];
      },
    },
    {
      id: 'artstation',
      hosts: ['artstation.com'],
      run(u) {
        if (!/\/p\/assets\/images\//.test(u.pathname)) return [];
        const np = u.pathname.replace(/\/(?:micro_square|smaller_square|small|medium)\//, '/large/');
        return np !== u.pathname ? [withPath(u, np)] : [];
      },
    },
  ];

  function normalizeCandidates(list, original) {
    const out = [];
    const seen = new Set([original]);
    for (const raw of list) {
      const abs = absUrl(raw);
      if (!abs || !/^https?:\/\//i.test(abs)) continue;
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push(abs);
    }
    return out;
  }

  /**
   * Upgrade an image URL to its highest-quality variant.
   * @param {string} raw
   * @param {string} [base] used to resolve relative URLs
   * @returns {{original:string|null, url:string, candidates:string[], changed:boolean, rule:string|null}}
   */
  function upgradeUrl(raw, base) {
    const u = parseUrl(raw, base);
    const original = u ? u.href : absUrl(raw, base);
    if (!u) {
      return { original, url: original || String(raw || ''), candidates: [], changed: false, rule: null };
    }

    let matched = null;
    let candidates = [];
    for (const rule of RULES) {
      if (!matchesHost(u.hostname, rule.hosts)) continue;
      matched = rule;
      try {
        candidates = rule.run(u) || [];
      } catch (e) {
        candidates = [];
      }
      break;
    }

    if (!matched) candidates = genericUpgrade(u);

    const list = normalizeCandidates(candidates, original);
    return {
      original,
      url: list[0] || original,
      candidates: list,
      changed: list.length > 0,
      rule: list.length ? (matched ? matched.id : 'generic') : null,
    };
  }

  /** Pick the largest candidate from a srcset attribute. */
  function pickFromSrcset(srcset, base) {
    if (!srcset) return '';
    const found = [];
    const parts = String(srcset).split(',');
    for (const raw of parts) {
      const part = raw.trim();
      if (!part) continue;
      if (/^data:/i.test(part)) continue;
      const m = part.match(/^(\S+?)(?:\s+([\d.]+)(w|x))?$/i);
      if (!m) continue;
      const url = absUrl(m[1], base);
      if (!url) continue;
      const value = m[2] ? parseFloat(m[2]) : 1;
      const unit = (m[3] || '').toLowerCase();
      const score = !m[2] ? 1 : unit === 'w' ? value : value * 1000000;
      found.push({ url, score });
    }
    found.sort((a, b) => b.score - a.score);
    return found.length ? found[0].url : '';
  }

  /** Rough pixel width parsed from a URL, used only as a tie-breaker. */
  function widthHint(url) {
    try {
      const u = new URL(url);
      for (const key of ['w', 'width', 'maxwidth', 'max-width', 'resize', 'size']) {
        const value = u.searchParams.get(key);
        const m = value && value.match(/^(\d{2,5})/);
        if (m) return Number(m[1]);
      }
      const p = u.pathname;
      let m = p.match(/[_@,-](\d{2,5})w(?:[_.-]|$)/i);
      if (m) return Number(m[1]);
      m = p.match(/[_@,-](\d{2,5})x(\d{2,5})(?:[_.-]|$)/i);
      if (m) return Number(m[1]);
      m = p.match(/\/(\d{2,4})x\d{0,4}\//);
      if (m) return Number(m[1]);
      m = p.match(/=s(\d+)$/);
      if (m) return Number(m[1]);
    } catch (e) {
      /* ignore */
    }
    return 0;
  }

  function isImageUrl(url) {
    if (!url) return false;
    if (/^data:image\//i.test(url)) return true;
    if (IMAGE_EXT_RE.test(url)) return true;
    return /[?&](?:wx_fmt|format)=(?:jpe?g|png|gif|webp|avif)\b/i.test(url);
  }

  function isPlaceholderUrl(url) {
    if (!url) return true;
    if (/^data:/i.test(url)) {
      if (url.length < 3000) return true;
      return /R0lGODlhAQAB|iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB/i.test(url);
    }
    let path = url;
    try {
      path = new URL(url).pathname;
    } catch (e) {
      /* ignore */
    }
    if (/\/(?:1x1|spacer|blank|transparent|pixel|loading|placeholder)(?:[._-][^/]*)?$/i.test(path)) return true;
    if (/(?:^|[_-])(?:1x1|spacer|blank|transparent)(?:[_-]|\.)/i.test(path)) return true;
    return false;
  }

  /** Is the current host disabled by the user?  Suffix match, www-insensitive. */
  function isDisabledSite(host, list) {
    if (!host || !Array.isArray(list) || !list.length) return false;
    const h = String(host).toLowerCase().replace(/^www\./, '');
    return list.some((raw) => {
      let d = String(raw || '').trim().toLowerCase();
      if (!d) return false;
      d = d.replace(/^https?:\/\//, '').split('/')[0].replace(/^\*\./, '').replace(/^www\./, '');
      return d && (h === d || h.endsWith('.' + d));
    });
  }

  return {
    VERSION,
    DEFAULT_SETTINGS,
    upgradeUrl,
    pickFromSrcset,
    widthHint,
    isImageUrl,
    isPlaceholderUrl,
    isDisabledSite,
    absUrl,
    parseUrl,
  };
});

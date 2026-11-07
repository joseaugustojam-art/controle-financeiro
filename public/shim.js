/* Camada de dados do app: fala com as funções da Netlify (/api/*).
   Mantém a mesma interface usada pelo app (claude.use('db' | 'user' | 'sample')). */
(() => {
  const tk = () => localStorage.getItem('cf_tk');
  async function api(p, o = {}) {
    const r = await fetch('/api' + p, { ...o, headers: { 'content-type': 'application/json', ...(tk() ? { authorization: 'Bearer ' + tk() } : {}), ...(o.headers || {}) } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || 'Erro ' + r.status), { code: j.code || String(r.status), status: r.status });
    return j;
  }
  window.CFAPI = api;

  let docs = {}, subs = [], timer = null, waiters = [], me = null;
  const uid = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  const clone = (d) => JSON.parse(JSON.stringify(d));
  const snap = () => ({ docs: Object.entries(docs).map(([id, d]) => ({ id, data: () => d })) });
  const notify = () => subs.forEach((f) => f(snap()));
  const flush = () => new Promise((ok, no) => {
    waiters.push({ ok, no });
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const w = waiters; waiters = [];
      try { await api('/data', { method: 'PUT', body: JSON.stringify({ docs }) }); w.forEach((x) => x.ok()); }
      catch (e) { w.forEach((x) => x.no(e)); }
    }, 400);
  });

  window.CFLOAD = async () => { me = await api('/me'); docs = (await api('/data')).docs || {}; };

  const col = {
    doc: (id) => ({
      get: async () => ({ exists: id in docs, data: () => docs[id] }),
      set: (d) => { docs[id] = clone(d); notify(); return flush(); },
      update: (d) => { docs[id] = { ...(docs[id] || {}), ...clone(d) }; notify(); return flush(); },
      delete: () => { delete docs[id]; notify(); return flush(); },
    }),
    add: (d) => { const id = uid(); docs[id] = clone(d); notify(); return flush().then(() => ({ id })); },
    onSnapshot: (f) => { subs.push(f); f(snap()); return () => { subs = subs.filter((x) => x !== f); }; },
  };

  const sample = async () => {};
  sample.limits = async () => ({ images: { maxCount: 8 } });
  sample.json = async (_p, o) => {
    const imgs = await Promise.all(o.images.map((b) => new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result.split(',')[1]); f.readAsDataURL(b); })));
    const id = uid();
    await api('/ocr-start', { method: 'POST', body: JSON.stringify({ id, images: imgs, texts: o.texts || [], meta: o.meta }) });
    for (let i = 0; i < 110; i++) {
      await new Promise((r) => setTimeout(r, i < 4 ? 1200 : 2000));
      const s = await api('/ocr-status?id=' + id);
      if (s.status === 'done') return s.data;
      if (s.status === 'error') throw Object.assign(new Error(s.message || 'Falha na leitura.'), { code: s.code || 'ocr_error' });
    }
    throw Object.assign(new Error('Tempo esgotado na leitura da fatura.'), { code: 'timeout' });
  };

  window.claude = {
    use: async (n) => n === 'db' ? { collection: () => col }
      : n === 'user' ? { isOwner: async () => false, id: async () => (me && me.id) || null }
      : n === 'sample' ? sample : null,
  };
})();

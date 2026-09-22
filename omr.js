'use strict';
/* =====================================================================
   楽譜スキャン（半自動の楽譜認識 / OMR）
   PDF・画像 → 五線・小節線・符頭を検出 → 音の高さとリズムを推定
   → 画面でタップ修正 → MIDI保存 / カード作成
   すべて端末内で処理（外部送信なし）
   ===================================================================== */
const OMR = (() => {
  const TARGET_W = 2400;           // 解析時のページ幅(px)
  const MAX_PAGES = 20;
  const yieldUI = () => new Promise(r => setTimeout(r, 0));

  /* ---------- 読み込み ---------- */
  async function loadPages(file, prog){
    const out = [];
    if(file.type === 'application/pdf' || /\.pdf$/i.test(file.name)){
      if(!window.pdfjsLib) throw new Error('PDF読み込みライブラリを読み込めませんでした。一度ネットにつないで開き直してください。');
      if(!pdfjsLib.GlobalWorkerOptions.workerSrc) pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const pdf = await pdfjsLib.getDocument({data: new Uint8Array(await file.arrayBuffer())}).promise;
      const n = Math.min(pdf.numPages, MAX_PAGES);
      for(let i=1;i<=n;i++){
        prog(`PDFを読み込み中… ${i}/${n}ページ`); await yieldUI();
        const page = await pdf.getPage(i);
        const vp1 = page.getViewport({scale:1});
        const vp = page.getViewport({scale: TARGET_W / vp1.width});
        const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        const x = c.getContext('2d', {willReadFrequently:true}); x.fillStyle = '#fff'; x.fillRect(0,0,c.width,c.height);
        await page.render({canvasContext:x, viewport:vp}).promise;
        out.push(c);
      }
    } else {
      const url = URL.createObjectURL(file);
      const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('画像を読み込めませんでした')); im.src = url; });
      const sc = TARGET_W / img.naturalWidth;
      const c = document.createElement('canvas'); c.width = TARGET_W; c.height = Math.round(img.naturalHeight * sc);
      const x = c.getContext('2d', {willReadFrequently:true}); x.fillStyle = '#fff'; x.fillRect(0,0,c.width,c.height);
      x.drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      out.push(c);
    }
    return out;
  }

  /* ---------- 2値化（局所平均＋大津） ---------- */
  function gray(c){
    const W = c.width, H = c.height, d = c.getContext('2d', {willReadFrequently:true}).getImageData(0,0,W,H).data;
    const g = new Uint8Array(W*H);
    for(let i=0,j=0;i<g.length;i++,j+=4) g[i] = (d[j]*77 + d[j+1]*150 + d[j+2]*29) >> 8;
    return {g, W, H};
  }
  function otsu(g){
    const h = new Float64Array(256); for(let i=0;i<g.length;i++) h[g[i]]++;
    let sum = 0; for(let i=0;i<256;i++) sum += i*h[i];
    let sB = 0, wB = 0, best = 0, t = 128; const tot = g.length;
    for(let i=0;i<256;i++){ wB += h[i]; if(!wB) continue; const wF = tot - wB; if(!wF) break; sB += i*h[i];
      const mB = sB/wB, mF = (sum - sB)/wF, v = wB*wF*(mB-mF)*(mB-mF); if(v > best){ best = v; t = i; } }
    return t;
  }
  function binarize({g, W, H}){
    const T = otsu(g), r = Math.max(8, Math.round(W/60));
    const I = new Uint32Array((W+1)*(H+1));
    for(let y=0;y<H;y++){ let row = 0; for(let x=0;x<W;x++){ row += g[y*W+x]; I[(y+1)*(W+1)+x+1] = I[y*(W+1)+x+1] + row; } }
    const b = new Uint8Array(W*H);
    for(let y=0;y<H;y++){
      const y0 = Math.max(0,y-r), y1 = Math.min(H,y+r+1);
      for(let x=0;x<W;x++){
        const x0 = Math.max(0,x-r), x1 = Math.min(W,x+r+1);
        const m = (I[y1*(W+1)+x1] - I[y0*(W+1)+x1] - I[y1*(W+1)+x0] + I[y0*(W+1)+x0]) / ((y1-y0)*(x1-x0));
        const v = g[y*W+x];
        b[y*W+x] = (v < m*0.86 && v < T + 25) ? 1 : 0;
      }
    }
    return b;
  }

  /* ---------- 傾き補正 ---------- */
  function skewSlope(b, W, H){
    const off = Math.ceil(W*0.07) + 2, proj = new Float32Array(H + 2*off);
    const score = t => {
      proj.fill(0);
      for(let y=0;y<H;y+=2){ const row = y*W; for(let x=0;x<W;x+=3) if(b[row+x]) proj[(y - x*t + off) | 0]++; }
      let s = 0; for(let i=0;i<proj.length;i++) s += proj[i]*proj[i]; return s;
    };
    let best = 0, bs = -1;
    for(let a=-3; a<=3.0001; a+=0.1){ const t = Math.tan(a*Math.PI/180), s = score(t); if(s > bs){ bs = s; best = a; } }
    const c = best;
    for(let a=c-0.1; a<=c+0.1001; a+=0.02){ const t = Math.tan(a*Math.PI/180), s = score(t); if(s > bs){ bs = s; best = a; } }
    return best; // 度
  }
  function rotateCanvas(c, deg){
    const o = document.createElement('canvas'); o.width = c.width; o.height = c.height;
    const x = o.getContext('2d', {willReadFrequently:true}); x.fillStyle = '#fff'; x.fillRect(0,0,o.width,o.height);
    x.translate(o.width/2, o.height/2); x.rotate(-deg*Math.PI/180); x.drawImage(c, -c.width/2, -c.height/2);
    return o;
  }

  /* ---------- 五線 ---------- */
  function findStaves(b, W, H){
    // 各行の「途切れの少ない最長の横線」の長さ
    const h = new Int32Array(H);
    for(let y=0;y<H;y++){ const row = y*W; let best = 0, run = 0, gap = 0;
      for(let x=0;x<W;x++){ if(b[row+x] || (y>0 && b[row-W+x]) || (y<H-1 && b[row+W+x])){ run += 1 + gap; gap = 0; if(run > best) best = run; } else if(run){ gap++; if(gap > 3){ run = 0; gap = 0; } } }
      h[y] = best; }
    const th = Math.max(W*0.08, 120), lines = [];
    for(let y=0;y<H;){
      if(h[y] >= th){ let e = y; while(e+1 < H && h[e+1] >= th) e++; if(e - y < 12) lines.push({a:y, b:e, y:(y+e)/2}); y = e+1; } else y++;
    }
    const staves = [];
    for(let i=0; i+4 < lines.length; ){
      const L = lines.slice(i, i+5), gp = [1,2,3,4].map(k => L[k].y - L[k-1].y), m = gp.reduce((a,c)=>a+c)/4;
      if(m >= 5 && gp.every(g => Math.abs(g-m) <= 0.22*m + 1)){ staves.push({lines:L, ys:L.map(l=>l.y), s:m, top:L[0].y, bot:L[4].y}); i += 5; }
      else i++;
    }
    for(const st of staves){ // 横方向の範囲
      const on = new Uint8Array(W);
      for(let x=0;x<W;x++){ let c = 0; for(const l of st.lines){ let hit = 0; for(let y=l.a-1;y<=l.b+1;y++) if(y>=0 && y<H && b[y*W+x]) { hit = 1; break; } c += hit; } on[x] = c >= 4 ? 1 : 0; }
      let bestA = 0, bestB = -1, a = -1, last = -1e9; const gap = st.s;
      for(let x=0;x<W;x++){ if(on[x]){ if(x - last > gap){ a = x; } last = x; if(last - a > bestB - bestA){ bestA = a; bestB = last; } } }
      st.x0 = bestA; st.x1 = bestB;
    }
    return staves.filter(st => st.x1 - st.x0 > st.s*20);
  }
  function removeStaffLines(b, W, H, staves){
    const nb = b.slice();
    for(const st of staves) for(const l of st.lines){
      const a = l.a - 1, e = l.b + 1;
      for(let x=Math.max(0,st.x0-3); x<=Math.min(W-1,st.x1+3); x++){
        const up = a-1 >= 0 ? b[(a-1)*W+x] : 0, dn = e+1 < H ? b[(e+1)*W+x] : 0;
        if(!up && !dn) for(let y=a;y<=e;y++) if(y>=0 && y<H) nb[y*W+x] = 0;
      }
    }
    return nb;
  }

  /* ---------- 符頭 ---------- */
  function detectHeads(b, W, H, s, staves){
    const N = W*H, q = new Int32Array(N);
    // 1) 外側の背景を塗る → 残った白 = 穴（白玉の中など）※五線ありの画像で判定
    const ext = new Uint8Array(N); let qh = 0, qt = 0;
    const push = i => { if(!b[i] && !ext[i]){ ext[i] = 1; q[qt++] = i; } };
    for(let x=0;x<W;x++){ push(x); push((H-1)*W+x); } for(let y=0;y<H;y++){ push(y*W); push(y*W+W-1); }
    while(qh < qt){ const i = q[qh++], x = i % W; if(x>0) push(i-1); if(x<W-1) push(i+1); if(i>=W) push(i-W); if(i<N-W) push(i+W); }
    const filled = b.slice(), hole = new Uint8Array(N), seen = new Uint8Array(N);
    for(let i0=0;i0<N;i0++){
      if(b[i0] || ext[i0] || seen[i0]) continue;
      qh = 0; qt = 0; q[qt++] = i0; seen[i0] = 1; let x0=W, x1=0, y0=H, y1=0;
      while(qh < qt){ const i = q[qh++], x = i % W, y = (i / W) | 0; if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y;
        for(const j of [i-1,i+1,i-W,i+W]) if(j>=0 && j<N && !b[j] && !ext[j] && !seen[j]){ seen[j] = 1; q[qt++] = j; } }
      const w = x1-x0+1, h = y1-y0+1, fr = qt/(w*h);
      if(w <= 1.3*s && h <= 0.9*s && qt <= 0.9*s*s && fr < 0.86){
        // 端の列が高い＝まっすぐな縦線（符幹・小節線・♯♭の縦棒）に接している → 符頭の穴ではない
        let cl = 0, cr = 0; for(let k=0;k<qt;k++){ const x = q[k] % W; if(x === x0) cl++; if(x === x1) cr++; }
        if(h < 0.4*s || (cl < 0.6*h && cr < 0.6*h)) for(let k=0;k<qt;k++){ filled[q[k]] = 1; hole[q[k]] = 1; }
      }
    }
    // 2) 五線を消す（白玉の中は埋めてあるので残る）
    const nb = removeStaffLines(filled, W, H, staves);
    // 3) 距離変換（chamfer 3-4）
    const d = new Uint16Array(N);
    for(let i=0;i<N;i++) d[i] = nb[i] ? 65000 : 0;
    for(let y=0;y<H;y++) for(let x=0;x<W;x++){ const i = y*W+x; if(!d[i]) continue;
      d[i] = Math.min(d[i], x>0 ? d[i-1]+3 : 3, y>0 ? d[i-W]+3 : 3, (x>0&&y>0) ? d[i-W-1]+4 : 4, (x<W-1&&y>0) ? d[i-W+1]+4 : 4); }
    for(let y=H-1;y>=0;y--) for(let x=W-1;x>=0;x--){ const i = y*W+x; if(!d[i]) continue;
      d[i] = Math.min(d[i], x<W-1 ? d[i+1]+3 : 3, y<H-1 ? d[i+W]+3 : 3, (x<W-1&&y<H-1) ? d[i+W+1]+4 : 4, (x>0&&y<H-1) ? d[i+W-1]+4 : 4); }
    const T = Math.max(3, Math.round(3*0.3*s));
    const inkAt = (x,y) => x>=0 && x<W && y>=0 && y<H && nb[y*W+x] === 1;
    const vrun = (x, y) => { x = Math.round(x); y = Math.round(y); if(!inkAt(x,y)) return 0; let u = y, dn = y; while(inkAt(x,u-1)) u--; while(inkAt(x,dn+1)) dn++; return dn - u + 1; };
    const hrun = (x, y) => { x = Math.round(x); y = Math.round(y); if(!inkAt(x,y)) return 0; let l = x, r = x; while(inkAt(l-1,y)) l--; while(inkAt(r+1,y)) r++; return r - l + 1; };
    // 4) 芯を連結成分に → 形で判定
    const heads = []; seen.fill(0);
    for(let i0=0;i0<N;i0++){
      if(d[i0] < T || seen[i0]) continue;
      qh = 0; qt = 0; q[qt++] = i0; seen[i0] = 1; let x0=W,x1=0,y0=H,y1=0,sx=0,sy=0,md=0;
      while(qh < qt){ const i = q[qh++], x = i % W, y = (i/W)|0; sx+=x; sy+=y; if(d[i]>md) md=d[i]; if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y;
        for(const j of [i-1,i+1,i-W,i+W,i-W-1,i-W+1,i+W-1,i+W+1]) if(j>=0 && j<N && d[j] >= T && !seen[j]){ seen[j] = 1; q[qt++] = j; } }
      const w = x1-x0+1, h = y1-y0+1;
      if(w > 1.25*s || w < 0.6*s || h > 3.3*s || md < 3*0.38*s) continue;
      const cx = sx/qt;
      // 縦に重なった和音（3度など）は分割
      const n = h > 1.0*s ? Math.max(1, Math.round((h - 0.4*s)/s) + 1) : 1;
      const cys = n === 1 ? [sy/qt] : Array.from({length:n}, (_,k) => y0 + (h - (n-1)*s)/2 + k*s);
      for(const cy of cys){
      if(hrun(cx, cy) > 2.8*s) continue;           // 横に長い（連桁など）
      let hc = 0, tc = 0;
      for(let yy=Math.round(cy-0.2*s); yy<=Math.round(cy+0.2*s); yy++) for(let xx=Math.round(cx-0.25*s); xx<=Math.round(cx+0.25*s); xx++){ const k = yy*W+xx; if(k>=0&&k<N){ tc++; hc += hole[k]; } }
      const hollow = hc > tc*0.25;
      // 符幹があるか（全音符以外は必ずある）
      let stem = 0;
      for(let dx=-Math.round(0.95*s); dx<=Math.round(0.95*s); dx++){ const r = vrun(cx+dx, cy); if(r > stem) stem = r; }
      const hasStem = stem >= 2.5*s;
      if(!hasStem && !hollow) continue;
      if(!hasStem && vrun(cx, cy) > 1.45*s) continue; // 符幹のない縦長の形（数字・記号）
      heads.push({x:cx, y:cy, hollow, stem:hasStem});
      }
    }
    return heads;
  }

  /* ---------- 段（システム）と小節線 ---------- */
  function buildSystems(staves, mode){
    const sys = [];
    if(mode === 'piano'){ for(let i=0;i<staves.length;i+=2){ if(i+1 < staves.length) sys.push([i, i+1]); else sys.push([i]); } }
    else staves.forEach((_,i) => sys.push([i]));
    return sys.map(ix => ({staff: ix, bars: []}));
  }
  function detectBars(b, W, H, staves, systems, heads){
    for(const sy of systems){
      const A = staves[sy.staff[0]], B = staves[sy.staff[sy.staff.length-1]], s = A.s;
      const top = Math.round(A.top), bot = Math.round(B.bot), need = (bot - top + 1)*0.9;
      const x0 = Math.min(...sy.staff.map(i=>staves[i].x0)), x1 = Math.max(...sy.staff.map(i=>staves[i].x1));
      const cand = [];
      for(let x=Math.max(1,x0-2); x<=Math.min(W-2,x1+2); x++){
        let n = 0; for(let y=top;y<=bot;y++){ const k = y*W+x; if(b[k] || b[k-1] || b[k+1]) n++; }
        if(n >= need) cand.push(x);
      }
      const runs = [];
      for(const x of cand){ const r = runs[runs.length-1]; if(r && x - r.b <= 2) r.b = x; else runs.push({a:x, b:x}); }
      const hs = heads.filter(h => h.y > top - 5*s && h.y < bot + 5*s);
      let xs = runs.filter(r => r.b - r.a <= 0.8*s).map(r => (r.a + r.b)/2)
        .filter(x => !hs.some(h => Math.abs(h.x - x) < 0.9*s));
      const merged = []; for(const x of xs){ if(merged.length && x - merged[merged.length-1] < 1.2*s) merged[merged.length-1] = (merged[merged.length-1] + x)/2; else merged.push(x); }
      sy.x0 = x0; sy.x1 = x1; sy.top = top; sy.bot = bot; sy.s = s;
      sy.bars = merged.filter(x => x > x0 + 1.5*s && x < x1 - 1.5*s);
    }
  }

  /* ---------- ページ解析 ---------- */
  async function analyzePage(c0, mode, prog, key, firstPage){
    prog('画像を2値化しています…'); await yieldUI();
    let G = gray(c0), b = binarize(G);
    prog('傾きを補正しています…'); await yieldUI();
    const ang = skewSlope(b, G.W, G.H);
    let c = c0;
    if(Math.abs(ang) > 0.05){ c = rotateCanvas(c0, Math.atan(Math.tan(ang*Math.PI/180))*180/Math.PI); G = gray(c); b = binarize(G); }
    const {W, H} = G;
    prog('五線を探しています…'); await yieldUI();
    const staves = findStaves(b, W, H);
    if(!staves.length) return {canvas:c, W, H, staves:[], systems:[], heads:[], angle:ang};
    const s = staves.map(st=>st.s).sort((a,b)=>a-b)[staves.length>>1];
    prog('音符を探しています…'); await yieldUI();
    const raw = detectHeads(b, W, H, s, staves);
    const systems = buildSystems(staves, mode);
    // 五線に割り当て
    const heads = [];
    for(const h of raw){
      let bi = -1, bd = 1e9;
      staves.forEach((st, i) => { const mid = (st.top + st.bot)/2, dd = Math.abs(h.y - mid); if(h.y > st.top - 5*st.s && h.y < st.bot + 5*st.s && dd < bd){ bd = dd; bi = i; } });
      if(bi < 0) continue;
      const st = staves[bi];
      const sysFirst = firstPage && staves.indexOf(st) < (mode === 'piano' ? 2 : 1);
      const zone = 4.0 + Math.abs(key||0)*1.15 + (sysFirst ? 2.6 : 0); // 音部記号＋調号（＋拍子記号）
      if(h.x < st.x0 + zone*st.s || h.x > st.x1 + st.s) continue;
      const step = Math.round((st.bot - h.y) / (st.s/2));
      if(Math.abs(step) > 14) continue;
      heads.push({x:h.x, y:h.y, staff:bi, step, hollow:h.hollow});
    }
    prog('小節線を探しています…'); await yieldUI();
    detectBars(b, W, H, staves, systems, heads);
    return {canvas:c, W, H, staves, systems, heads, angle:ang};
  }

  /* ---------- リズム推定（間隔からDPで割り当て） ---------- */
  function assignDurations(gaps, hollowCol, beats, q){
    const n = gaps.length; if(!n) return [];
    if(n === 1) return [beats];
    const cand = (q === 0.25 ? [0.25,0.5,0.75,1,1.5,2,3,4] : [0.5,1,1.5,2,3,4]).filter(d => d <= beats);
    const U = Math.round(beats/q);
    if(n > U) return gaps.map(() => beats/n);
    const lg = gaps.map(g => Math.log(Math.max(g, 1)));
    const mean = lg.reduce((a,c)=>a+c)/n;
    let best = null, bestCost = Infinity;
    for(let k=-25;k<=25;k++){
      const lc = mean + k*0.07;
      const dp = Array.from({length:n+1}, () => new Float64Array(U+1).fill(Infinity));
      const ch = Array.from({length:n+1}, () => new Int8Array(U+1).fill(-1));
      dp[0][0] = 0;
      for(let i=0;i<n;i++) for(let u=0;u<=U;u++){
        if(dp[i][u] === Infinity) continue;
        cand.forEach((d, di) => {
          const du = Math.round(d/q); if(u + du > U) return;
          const e = lg[i] - lc - 0.6*Math.log(d);
          const c = dp[i][u] + e*e + (hollowCol[i] && d < 2 ? 0.6 : 0) + (i < n-1 && u + du === U ? 99 : 0);
          if(c < dp[i+1][u+du]){ dp[i+1][u+du] = c; ch[i+1][u+du] = di; }
        });
      }
      if(dp[n][U] < bestCost){
        bestCost = dp[n][U]; const res = []; let u = U;
        for(let i=n;i>0;i--){ const d = cand[ch[i][u]]; res.unshift(d); u -= Math.round(d/q); }
        best = res;
      }
    }
    return best || gaps.map(() => beats/n);
  }

  /* ---------- 音の高さ ---------- */
  const WH = [0,2,4,5,7,9,11];
  const SHARP_ORDER = [3,0,4,1,5,2,6], FLAT_ORDER = [6,2,5,1,4,0,3];
  function keyAcc(key){ const a = [0,0,0,0,0,0,0]; if(key > 0) SHARP_ORDER.slice(0,key).forEach(l => a[l] = 1); if(key < 0) FLAT_ORDER.slice(0,-key).forEach(l => a[l] = -1); return a; }
  function pitchOf(step, clef, acc){
    const d = (clef === 'F' ? 18 : 30) + step;   // ヘ音:第1線=G2 / ト音:第1線=E4
    const l = ((d % 7) + 7) % 7;
    return 12*(Math.floor(d/7) + 1) + WH[l] + acc[l];
  }
  const KANA = ['ド','レ','ミ','ファ','ソ','ラ','シ'];
  function nameOf(step, clef, acc){ const d = (clef === 'F' ? 18 : 30) + step, l = ((d%7)+7)%7; return KANA[l] + (acc[l] > 0 ? '♯' : acc[l] < 0 ? '♭' : ''); }

  /* ---------- 曲データの組み立て ---------- */
  function clefOf(page, staffIdx, mode){
    if(mode !== 'piano') return mode === 'bass' ? 'F' : 'G';
    const sy = page.systems.find(y => y.staff.includes(staffIdx));
    return sy && sy.staff.length === 2 && sy.staff[1] === staffIdx ? 'F' : 'G';
  }
  function build(pages, opt){
    const acc = keyAcc(opt.key), out = []; let m = 0;
    for(const pg of pages){
      pg.systems.forEach((sy, si) => {
        const s = sy.s, bounds = [sy.x0, ...sy.bars.slice().sort((a,b)=>a-b), sy.x1];
        const inSys = pg.heads.filter(h => sy.staff.includes(h.staff));
        for(let k=0;k<bounds.length-1;k++){
          const L = bounds[k], R = bounds[k+1]; if(R - L < 1.5*s) continue;
          const hs = inSys.filter(h => h.x > L + 0.3*s && h.x < R - 0.3*s).sort((a,b)=>a.x-b.x);
          const cols = [];
          for(const h of hs){ const c = cols[cols.length-1]; if(c && h.x - c.x0 < 0.6*s){ c.h.push(h); } else cols.push({x0:h.x, h:[h]}); }
          cols.forEach(c => c.x = c.h.reduce((a,h)=>a+h.x,0)/c.h.length);
          if(cols.length){
            const first = Math.min(cols[0].x - L, 1.5*s);
            const gaps = cols.map((c,i) => i < cols.length-1 ? cols[i+1].x - c.x : (R - c.x) + first);
            const durs = assignDurations(gaps, cols.map(c => c.h.every(h=>h.hollow)), opt.beats, opt.q);
            let t = 0;
            cols.forEach((c, i) => { for(const h of c.h){ const clef = clefOf(pg, h.staff, opt.mode); out.push({b: m*opt.beats + t, p: pitchOf(h.step, clef, acc), tr: clef === 'F' ? 1 : 0}); } t += durs[i]; });
          }
          m++;
        }
      });
    }
    return {notes: out, measures: m};
  }

  /* ---------- MIDI書き出し ---------- */
  function writeMidi(notes, bpm){
    const TP = 480, ev = [];
    const byTr = {}; notes.forEach(n => (byTr[n.tr] = byTr[n.tr] || []).push(n));
    for(const tr in byTr){
      const arr = byTr[tr].sort((a,b)=>a.b-b.b), onsets = [...new Set(arr.map(n=>n.b))].sort((a,b)=>a-b);
      for(const n of arr){
        const on = Math.round(n.b*TP), nx = onsets.find(o => o > n.b);
        let dur = nx !== undefined ? Math.round((nx - n.b)*TP) : TP; dur = Math.max(60, Math.min(dur, TP*2));
        const p = Math.max(0, Math.min(127, n.p)), ch = (+tr) & 15;
        ev.push([on, 1, [0x90|ch, p, 90]]); ev.push([on + dur - 5, 0, [0x80|ch, p, 0]]);
      }
    }
    ev.sort((a,b) => a[0]-b[0] || a[1]-b[1]);
    const vlq = n => { const b = [n & 0x7f]; n >>= 7; while(n){ b.unshift((n & 0x7f) | 0x80); n >>= 7; } return b; };
    const us = Math.round(60000000 / (bpm || 90));
    let data = [0, 0xFF, 0x51, 3, (us>>16)&255, (us>>8)&255, us&255], last = 0;
    for(const [t,,e] of ev){ data.push(...vlq(t - last), ...e); last = t; }
    data.push(0, 0xFF, 0x2F, 0);
    const hdr = [0x4D,0x54,0x68,0x64, 0,0,0,6, 0,0, 0,1, (TP>>8)&255, TP&255];
    const L = data.length, trk = [0x4D,0x54,0x72,0x6B, (L>>>24)&255, (L>>16)&255, (L>>8)&255, L&255];
    return new Uint8Array([...hdr, ...trk, ...data]);
  }

  return {loadPages, analyzePage, build, writeMidi, nameOf, keyAcc, pitchOf, clefOf};
})();

/* =====================================================================
   画面（スキャンタブ）
   ===================================================================== */
const SCAN = {pages: [], cur: 0, mode: 'note', result: null, file: null};
function scanOpts(){ return {mode: $('scMode').value, key: +$('scKey').value, beats: +$('scBeats').value, q: +$('scQ').value}; }
$('scFile').onchange = ev => { SCAN.file = ev.target.files[0] || null; $('scFileName').textContent = SCAN.file ? SCAN.file.name : ''; $('scRun').disabled = !SCAN.file; };
async function scanRun(){
  if(!SCAN.file) return;
  const prog = m => { $('scProg').textContent = m; };
  $('scRun').disabled = true; $('scResult').style.display = 'none';
  try{
    const canvases = await OMR.loadPages(SCAN.file, prog);
    SCAN.pages = [];
    for(let i=0;i<canvases.length;i++){
      const pg = await OMR.analyzePage(canvases[i], $('scMode').value, m => prog(`${i+1}/${canvases.length}ページ：${m}`), +$('scKey').value, i === 0);
      pg.url = pg.canvas.toDataURL('image/jpeg', 0.7); delete pg.canvas;
      SCAN.pages.push(pg);
    }
    SCAN.cur = 0; SCAN.analyzedMode = $('scMode').value;
    const nst = SCAN.pages.reduce((a,p)=>a+p.staves.length,0);
    prog(nst ? '解析が終わりました。赤＝右手（ト音）、青＝左手（ヘ音）、緑＝小節線です。違うところをタップで直してください。' : '五線が見つかりませんでした。スキャンの解像度を上げるか、まっすぐに撮り直してください。');
    $('scResult').style.display = nst ? '' : 'none';
    scanRender();
  } catch(e){ prog(''); alert('解析できませんでした：' + e.message); }
  finally { $('scRun').disabled = false; }
}
function scanRecalc(){
  const r = OMR.build(SCAN.pages, scanOpts()); SCAN.result = r;
  const nh = SCAN.pages.reduce((a,p)=>a+p.heads.length,0);
  $('scStats').innerHTML = `<div class="stat"><b>${SCAN.pages.reduce((a,p)=>a+p.systems.length,0)}</b><small>段</small></div><div class="stat"><b>${r.measures}</b><small>小節</small></div><div class="stat"><b>${nh}</b><small>音符</small></div>`;
}
function scanRender(){
  scanRecalc();
  const pg = SCAN.pages[SCAN.cur]; if(!pg) return;
  $('scPageNo').textContent = `${SCAN.cur+1} / ${SCAN.pages.length}ページ`;
  const o = scanOpts(), acc = OMR.keyAcc(o.key);
  let svg = `<svg id="scSvg" viewBox="0 0 ${pg.W} ${pg.H}" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%">`;
  for(const st of pg.staves) for(const y of st.ys) svg += `<line x1="${st.x0}" y1="${y}" x2="${st.x1}" y2="${y}" stroke="#3a7bd5" stroke-width="${st.s*0.08}" opacity=".45"/>`;
  for(const sy of pg.systems){
    for(const x of sy.bars) svg += `<line x1="${x}" y1="${sy.top - sy.s}" x2="${x}" y2="${sy.bot + sy.s}" stroke="#2f9e44" stroke-width="${sy.s*0.35}" opacity=".6"/>`;
  }
  for(const h of pg.heads){
    const st = pg.staves[h.staff], clef = OMR.clefOf(pg, h.staff, o.mode), col = clef === 'F' ? '#1971c2' : '#e03131';
    svg += `<circle cx="${h.x}" cy="${h.y}" r="${st.s*0.62}" fill="none" stroke="${col}" stroke-width="${st.s*0.16}"/>`;
    svg += `<text x="${h.x + st.s*0.7}" y="${h.y - st.s*0.55}" font-size="${st.s*1.05}" fill="${col}" font-weight="700" font-family="sans-serif">${OMR.nameOf(h.step, clef, acc)}</text>`;
  }
  svg += '</svg>';
  $('scView').innerHTML = `<img src="${pg.url}" style="display:block;width:100%;height:auto">` + svg;
  $('scSvg').addEventListener('click', scanTap);
  document.querySelectorAll('.scModeBtn').forEach(b => b.classList.toggle('sub', b.dataset.m !== SCAN.mode));
}
function scanTap(ev){
  const pg = SCAN.pages[SCAN.cur], r = ev.currentTarget.getBoundingClientRect();
  const x = (ev.clientX - r.left) / r.width * pg.W, y = (ev.clientY - r.top) / r.height * pg.H;
  if(SCAN.mode === 'note'){
    const near = pg.heads.map((h,i) => ({i, d: Math.hypot(h.x-x, h.y-y), s: pg.staves[h.staff].s})).sort((a,b)=>a.d-b.d)[0];
    if(near && near.d < near.s*0.8){ pg.heads.splice(near.i, 1); }
    else {
      let bi = -1, bd = 1e9;
      pg.staves.forEach((st,i) => { const d = Math.abs(y - (st.top+st.bot)/2); if(y > st.top - 5*st.s && y < st.bot + 5*st.s && d < bd){ bd = d; bi = i; } });
      if(bi < 0) return toast('五線の近くをタップしてください');
      const st = pg.staves[bi], step = Math.round((st.bot - y)/(st.s/2));
      pg.heads.push({x, y: st.bot - step*st.s/2, staff: bi, step, hollow:false});
      const clef = OMR.clefOf(pg, bi, scanOpts().mode); beep(OMR.pitchOf(step, clef, OMR.keyAcc(scanOpts().key)) - 12);
    }
  } else {
    const sy = pg.systems.find(s => y > s.top - 3*s.s && y < s.bot + 3*s.s);
    if(!sy) return toast('段の中をタップしてください');
    const i = sy.bars.findIndex(bx => Math.abs(bx - x) < sy.s);
    if(i >= 0) sy.bars.splice(i, 1); else sy.bars.push(x);
  }
  scanRender();
}
$('scZoom').oninput = () => { $('scView').style.width = (+$('scZoom').value*100) + '%'; };
function scanSetMode(m){ SCAN.mode = m; scanRender(); }
function scanPage(d){ const n = SCAN.cur + d; if(n < 0 || n >= SCAN.pages.length) return; SCAN.cur = n; scanRender(); $('scWrap').scrollTop = 0; $('scWrap').scrollLeft = 0; }
['scKey','scBeats','scQ'].forEach(id => $(id).onchange = () => { if(SCAN.pages.length) scanRender(); });
$('scMode').onchange = () => { if(SCAN.pages.length) toast('楽譜の種類を変えたときは「解析する」をもう一度押してください'); };
function scanPlay(){
  if(!SCAN.result || !SCAN.result.notes.length) return toast('音符がありません');
  stopPlay(); const c = ac(), t0 = c.currentTime + 0.1, sp = 60 / (+$('scBpm').value || 90);
  const ns = [...SCAN.result.notes].sort((a,b)=>a.b-b.b); let idx = 0;
  const end = (ns[ns.length-1].b)*sp + 1.8;
  const timer = setInterval(() => { const now = c.currentTime - t0;
    while(idx < ns.length && ns[idx].b*sp < now + 1){ tone(ns[idx].p - 12, t0 + ns[idx].b*sp, c); idx++; }
    if(now > end) stopPlay(); }, 150);
  playing = {timer, t0, sp: sp/TPQ, onEnd:null};
}
function scanTitle(){ return ($('scTitle').value.trim() || (SCAN.file ? SCAN.file.name.replace(/\.[^.]+$/,'') : '楽譜')); }
function scanMidi(){
  if(!SCAN.result || !SCAN.result.notes.length) return toast('音符がありません');
  const bytes = OMR.writeMidi(SCAN.result.notes, +$('scBpm').value || 90), name = scanTitle().replace(/[\\/:*?"<>|]/g,'_') + '.mid';
  const blob = new Blob([bytes], {type:'audio/midi'}), file = new File([blob], name, {type:'audio/midi'});
  if(navigator.canShare && navigator.canShare({files:[file]}) && /iPhone|iPad|Android/i.test(navigator.userAgent)) navigator.share({files:[file], title:name}).catch(()=>{});
  else { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 4000); }
}
function scanToCard(){
  if(!SCAN.result || !SCAN.result.notes.length) return toast('音符がありません');
  stopPlay();
  const ns = SCAN.result.notes, mk = (tr, name) => { const n = ns.filter(x=>x.tr===tr).map(x=>({b:x.b, p:x.p})); if(!n.length) return null; const ps = n.map(x=>x.p); return {id:tr, name, notes:n, lo:Math.min(...ps), hi:Math.max(...ps)}; };
  const tracks = [mk(0,'右手（ト音記号）'), mk(1,'左手（ヘ音記号）')].filter(Boolean);
  openTracksImport('楽譜スキャンから取り込む', scanTitle(), tracks, +$('scBpm').value || 90, +$('scBeats').value);
}

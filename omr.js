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
      if(h[y] >= th){ let e = y; while(e+1 < H && h[e+1] >= th) e++; if(e - y < 60) lines.push({a:y, b:e, y:(y+e)/2}); y = e+1; } else y++;
    }
    if(lines.length < 5) return [];
    // 普通の線の太さ → それより太いものは「五線＋連桁が重なった」候補
    const tks = lines.map(l => l.b - l.a).sort((a,b)=>a-b), tt = tks[tks.length>>1];
    lines.forEach(l => l.thick = (l.b - l.a) > tt + 3);
    // 線の間隔（最頻値）
    const hist = new Map();
    const thin = lines.filter(l => !l.thick);
    for(let i=0;i+1<thin.length;i++){ const g = Math.round(thin[i+1].y - thin[i].y); if(g >= 5 && g < 80) hist.set(g, (hist.get(g)||0) + 1); }
    let sg = 0, sc = -1;
    for(const [g] of hist){ const c = (hist.get(g-1)||0) + 2*(hist.get(g)||0) + (hist.get(g+1)||0); if(c > sc){ sc = c; sg = g; } }
    const used = new Uint8Array(lines.length), staves = [];
    // 間に余計な線（連桁・加線など）が挟まっていても、等間隔の5本を探す
    for(let i=0;i<lines.length;i++){
      if(used[i] || lines[i].thick) continue;
      const L = [lines[i]], idx = [i]; let ok = true;
      for(let k=1;k<=4;k++){
        const target = lines[i].y + k*sg, tol = Math.max(1.6, 0.2*sg);
        let bj = -1, bd = 1e9;
        for(let j=i+1;j<lines.length && lines[j].a <= target + tol;j++){ if(used[j]) continue; const l = lines[j];
          const d = l.thick ? (target < l.a ? l.a - target : target > l.b ? target - l.b : 0) : Math.abs(l.y - target);
          if(d <= tol && d < bd){ bd = d; bj = j; } }
        if(bj < 0){ ok = false; break; }
        if(lines[bj].thick){ const a = Math.round(target - tt/2); L.push({a, b:a+tt, y:target}); }
        else { L.push(lines[bj]); idx.push(bj); }
      }
      if(!ok) continue;
      idx.forEach(j => used[j] = 1);
      const m = (L[4].y - L[0].y)/4;
      staves.push({lines:L, ys:L.map(l=>l.y), s:m, top:L[0].y, bot:L[4].y});
    }
    for(const st of staves){ // 横方向の範囲
      const on = new Uint8Array(W);
      for(let x=0;x<W;x++){ let c = 0; for(const l of st.lines){ let hit = 0; for(let y=l.a-1;y<=l.b+1;y++) if(y>=0 && y<H && b[y*W+x]) { hit = 1; break; } c += hit; } on[x] = c >= 4 ? 1 : 0; }
      let bestA = 0, bestB = -1, a = -1, last = -1e9; const gap = st.s;
      for(let x=0;x<W;x++){ if(on[x]){ if(x - last > gap){ a = x; } last = x; if(last - a > bestB - bestA){ bestA = a; bestB = last; } } }
      st.x0 = bestA; st.x1 = bestB;
    }
    return staves.filter(st => st.x1 - st.x0 > st.s*20).sort((a,b) => a.top - b.top);
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

  /* ---------- 符頭（＋符幹・連桁・付点 → 音価） ---------- */
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
    const vseg = (x, y) => { x = Math.round(x); y = Math.round(y); if(!inkAt(x,y)) return null; let u = y, dn = y; while(inkAt(x,u-1)) u--; while(inkAt(x,dn+1)) dn++; return {x, u, d:dn, len:dn-u+1}; };
    const hrun = (x, y) => { x = Math.round(x); y = Math.round(y); if(!inkAt(x,y)) return 0; let l = x, r = x; while(inkAt(l-1,y)) l--; while(inkAt(r+1,y)) r++; return r - l + 1; };
    // 連桁・旗の数（符幹の先端から数える）
    const beamAt = (st, up) => {        // 符幹のこの端に連桁（横に長い太線）があるか
      const tip = up ? st.u : st.d, dir = up ? 1 : -1;
      for(let k=0;k<=Math.min(st.len, 1.4*s);k++){ const y = tip + dir*k;
        for(const sg of [1,-1]){ let ok = true; for(let dd=Math.round(0.5*s); dd<=Math.round(1.5*s); dd+=2){ let hit = false; for(let e=-Math.round(0.6*s); e<=Math.round(0.6*s); e++) if(inkAt(st.x + sg*dd, y+e)){ hit = true; break; } if(!hit){ ok = false; break; } } if(ok) return true; } }
      return false;
    };
    const countBeams = (st, up) => {
      const tip = up ? st.u : st.d, dir = up ? 1 : -1;
      const L = Math.min(Math.max(0, st.len - 1.4*s), 3.6*s);
      const rows = [];
      for(let k=0;k<=L;k++){
        const y = tip + dir*k; let side = false;
        for(const sg of [1,-1]){ for(let dd=Math.round(0.5*s); dd<=Math.round(0.95*s); dd++) if(inkAt(st.x + sg*dd, y)){ side = true; break; } if(side) break; }
        rows.push(side);
      }
      // 連桁（となりの符幹まで横に長く続く）か、旗か
      let beam = false;
      for(let k=0;k<=Math.min(L, 1.4*s) && !beam;k++){ const y = tip + dir*k;
        for(const sg of [1,-1]){ let ok = true; for(let dd=Math.round(0.5*s); dd<=Math.round(1.8*s); dd+=2){ let hit = false; for(let e=-Math.round(0.35*s); e<=Math.round(0.35*s); e++) if(inkAt(st.x + sg*dd, y+e)){ hit = true; break; } if(!hit){ ok = false; break; } } if(ok){ beam = true; break; } } }
      if(beam){
        // 連桁は傾いているので、左右それぞれで数えて多い方を採る
        let best = 0;
        for(const sg of [1,-1]){
          const rr = [];
          const LB = Math.min(L, 2.1*s);   // 連桁は先端から2間ほどの範囲だけ（となりの符頭を数えない）
          const far = y => { for(let e=-Math.round(0.22*s); e<=Math.round(0.22*s); e++) for(let dd=Math.round(1.0*s); dd<=Math.round(1.25*s); dd++) if(inkAt(st.x + sg*dd, y+e)) return true; return false; };
          for(let k=0;k<=LB;k++){ const y = tip + dir*k; let hit = false; for(let dd=Math.round(0.45*s); dd<=Math.round(0.75*s); dd++) if(inkAt(st.x + sg*dd, y)){ hit = true; break; } rr.push(hit && far(y)); }   // 連桁は横に長く続く（♯などの短い線は数えない）
          let n = 0; for(let i=0;i<rr.length;){ if(rr[i]){ let j = i; while(j+1 < rr.length && rr[j+1]) j++; if(j-i+1 >= 0.22*s) n++; i = j+1; } else i++; }
          best = Math.max(best, n);
        }
        return Math.max(1, Math.min(best, 3));
      }
      // 旗：先端から旗が続く長さで判定（8分＝1本、16分＝2本…）
      let first = -1, last = -1;
      rows.forEach((r,i) => { if(r){ if(first < 0) first = i; last = i; } });
      if(first < 0 || first > 0.8*s) return 0;
      const span = last - first;
      return span > 3.6*s ? 2 : 1;   // 旗は書体によって長さが違うので、よほど長いときだけ16分とみなす
    };
    // 付点（符頭の右の小さな点）
    const hasDot = (cx, cy) => {
      const seenL = new Set();
      for(let y=Math.round(cy-0.7*s); y<=Math.round(cy+0.35*s); y++) for(let x=Math.round(cx+0.85*s); x<=Math.round(cx+2.0*s); x++){
        if(!inkAt(x,y) || seenL.has(y*W+x)) continue;
        const st = [[x,y]]; seenL.add(y*W+x); let n = 0, x0=x,x1=x,y0=y,y1=y, big = false;
        while(st.length){ const [a,c] = st.pop(); n++; if(a<x0)x0=a; if(a>x1)x1=a; if(c<y0)y0=c; if(c>y1)y1=c; if(n > s*s){ big = true; break; }
          for(const [p,r] of [[a+1,c],[a-1,c],[a,c+1],[a,c-1]]) if(inkAt(p,r) && !seenL.has(r*W+p)){ seenL.add(r*W+p); st.push([p,r]); } }
        const w = x1-x0+1, h = y1-y0+1;
        if(!big && w >= 0.18*s && h >= 0.18*s && w <= 0.62*s && h <= 0.62*s && n/(w*h) > 0.45) return true;
      }
      return false;
    };
    // 4) 芯を連結成分に → 形で判定
    const heads = []; seen.fill(0);
    for(let i0=0;i0<N;i0++){
      if(d[i0] < T || seen[i0]) continue;
      qh = 0; qt = 0; q[qt++] = i0; seen[i0] = 1; let x0=W,x1=0,y0=H,y1=0,sx=0,sy=0,md=0;
      while(qh < qt){ const i = q[qh++], x = i % W, y = (i/W)|0; sx+=x; sy+=y; if(d[i]>md) md=d[i]; if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y;
        for(const j of [i-1,i+1,i-W,i+W,i-W-1,i-W+1,i+W-1,i+W+1]) if(j>=0 && j<N && d[j] >= T && !seen[j]){ seen[j] = 1; q[qt++] = j; } }
      const comps = [];
      const w0 = x1-x0+1, h0 = y1-y0+1;
      if(w0 > 1.25*s && w0 < 4*s && h0 <= 1.5*s && md >= 3*0.4*s){
        // 符頭に♯や連桁が触れて横に長くなった → 芯をさらに細らせて符頭だけを取り出す
        const T2 = Math.round(3*0.4*s), pix = Array.from(q.subarray(0, qt)).filter(i => d[i] >= T2), inSet = new Set(pix), done = new Set();
        for(const p0 of pix){ if(done.has(p0)) continue; const stck = [p0]; done.add(p0); let a0=W,a1=0,b0=H,b1=0,ssx=0,ssy=0,cnt=0,mm=0;
          while(stck.length){ const i = stck.pop(), x = i % W, y = (i/W)|0; cnt++; ssx+=x; ssy+=y; if(d[i]>mm) mm=d[i]; if(x<a0)a0=x; if(x>a1)a1=x; if(y<b0)b0=y; if(y>b1)b1=y;
            for(const j of [i-1,i+1,i-W,i+W,i-W-1,i-W+1,i+W-1,i+W+1]) if(inSet.has(j) && !done.has(j)){ done.add(j); stck.push(j); } }
          comps.push({w:a1-a0+1, h:b1-b0+1, sx:ssx, sy:ssy, n:cnt, md:mm, y0:b0, minW:0.3*s}); }
      } else comps.push({w:w0, h:h0, sx, sy, n:qt, md, y0, minW:0.6*s});
      for(const cp of comps){
      const w = cp.w, h = cp.h;
      if(w > 1.25*s || w < cp.minW || h > 3.3*s || cp.md < 3*0.38*s) continue;
      const cx = cp.sx/cp.n;
      // 縦に重なった和音（3度など）は分割
      const n = h > 1.0*s ? Math.max(1, Math.round((h - 0.4*s)/s) + 1) : 1;
      const cys = n === 1 ? [cp.sy/cp.n] : Array.from({length:n}, (_,k) => cp.y0 + (h - (n-1)*s)/2 + k*s);
      for(const cy of cys){
        const hr = hrun(cx, cy);
        if(hr > 2.8*s || hr < 0.95*s) continue;      // 横に長い（連桁など）／小さすぎる（装飾音）
        { const v = vseg(cx, cy); if(!v || v.len < 0.72*s) continue; }   // 背が低い＝小さな装飾音符
        let hc = 0, tc = 0;
        for(let yy=Math.round(cy-0.2*s); yy<=Math.round(cy+0.2*s); yy++) for(let xx=Math.round(cx-0.25*s); xx<=Math.round(cx+0.25*s); xx++){ const k = yy*W+xx; if(k>=0&&k<N){ tc++; hc += hole[k]; } }
        const hollow = hc > tc*0.25;
        if(hollow && h < 0.35*s) continue;                  // 平たい「穴」（装飾音とスラーのすき間など）は白玉ではない
        // 符幹
        let stem = null;
        for(let dx=-Math.round(0.95*s); dx<=Math.round(0.95*s); dx++){ const r = vseg(cx+dx, cy); if(r && (!stem || r.len > stem.len)) stem = r; }
        const hasStem = !!stem && stem.len >= 2.5*s;
        if(!hasStem && !hollow) continue;
        if(!hasStem && n === 1 && vseg(cx, cy) && vseg(cx, cy).len > (hollow ? 1.15 : 1.45)*s) continue; // 符幹のない縦長の形（数字・記号）
        if(!hasStem && hr < 1.3*s) continue;                                  // 小さい白玉（装飾音など）
        { const exts = [];                                                   // 太い横棒（連桁）が横に続いている → 連桁の端で符頭ではない
          for(let yy=Math.round(cy-0.25*s); yy<=Math.round(cy+0.25*s); yy++){ let r = Math.round(cx), l = r; if(!inkAt(r,yy)){ exts.push(0); continue; } while(inkAt(r+1,yy)) r++; while(inkAt(l-1,yy)) l--; exts.push(Math.max(r - cx, cx - l)); }
          exts.sort((a,b)=>a-b); const med = exts[exts.length>>1];
          if(med > (hollow ? 1.6 : 2.2)*s) continue; }
        heads.push({x:cx, y:cy, hollow, stem: hasStem ? stem : null, dot: hasDot(cx, cy)});
      }
      }
    }
    // 符幹の向き：和音では符幹の両端に符頭があるので、「符頭のない端」を先端とする
    const headNear = (x, y, self) => heads.some(o => o !== self && Math.abs(o.y - y) < 0.9*s && Math.abs(o.x - x) < 1.4*s);
    for(const h of heads){
      let beams = 0, up = false;
      if(h.stem){
        const st = h.stem, uH = headNear(st.x, st.u, h) || Math.abs(st.u - h.y) < 0.9*s, dH = headNear(st.x, st.d, h) || Math.abs(st.d - h.y) < 0.9*s;
        if(uH && dH){                       // 符幹の両端に「符頭」→ 片方は連桁のかたまりの見間違い
          const selfUp = Math.abs(st.u - h.y) < Math.abs(st.d - h.y);
          if(beamAt(st, selfUp) && !beamAt(st, !selfUp)){ h.drop = true; continue; }
        }
        up = uH !== dH ? !uH : (h.y - st.u) > (st.d - h.y);
        { const tipY = up ? st.u : st.d, otherY = up ? st.d : st.u;   // 連桁のすぐ下（上）にある「符頭」は連桁と符幹の交点の見間違い
          if(Math.abs(tipY - h.y) < 2.0*s && headNear(st.x, otherY, h) && beamAt(st, up)){ h.drop = true; continue; } }
        if(!h.hollow) beams = countBeams(st, up);
      }
      let dur = h.hollow ? (h.stem ? 2 : 4) : [1, 0.5, 0.25, 0.125][beams];
      if(h.dot) dur *= 1.5;
      h.dur = dur; h.up = up; h.stemX = h.stem ? h.stem.x : null; delete h.stem;
    }
    return {heads: heads.filter(h => !h.drop), nb};
  }

  /* ---------- 臨時記号・調号（♯ ♭ ♮）の形を見分ける ---------- */
  function findAccidentals(nb, W, H, staves, stems){
    const N = W*H, lab = new Int32Array(N), q = new Int32Array(N), out = [], rests = [], clefs = [];
    let id = 0;
    for(let i0=0;i0<N;i0++){
      if(!nb[i0] || lab[i0]) continue;
      id++; let qh = 0, qt = 0; q[qt++] = i0; lab[i0] = id; let x0=W,x1=0,y0=H,y1=0;
      while(qh < qt){ const i = q[qh++], x = i % W, y = (i/W)|0; if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y;
        for(const j of [i-1,i+1,i-W,i+W,i-W-1,i-W+1,i+W-1,i+W+1]) if(j>=0 && j<N && nb[j] && !lab[j]){ lab[j] = id; q[qt++] = j; } }
      const w = x1-x0+1, h = y1-y0+1, cy = (y0+y1)/2;
      const st = staves.find(t => cy > t.top - 3*t.s && cy < t.bot + 3*t.s); if(!st) continue;
      const s = st.s;
      const colRun = x => { let best = 0, bu = 0, run = 0, ru = 0;
        for(let y=y0;y<=y1;y++){ if(lab[y*W+x] === id){ if(!run) ru = y; run++; if(run > best){ best = run; bu = ru; } } else run = 0; }
        return {len:best, top:bu, bot:bu+best-1}; };
      const pick = (a, b) => { let r = {len:0}; for(let x=a;x<=b;x++){ const c = colRun(x); if(c.len > r.len) r = c; } return r; };
      // ---- 音部記号（段の途中で変わることもある）----
      if(cy > st.top - 1.2*s && cy < st.bot + 1.2*s && w >= 1.4*s && w <= 3.4*s){
        const dn = qt/(w*h);
        const inkBox = (xa, xb, ya, yb) => { for(let yy=Math.round(ya); yy<=Math.round(yb); yy++) for(let xx=Math.round(xa); xx<=Math.round(xb); xx++) if(xx>=0 && yy>=0 && xx<W && yy<H && nb[yy*W+xx] && lab[yy*W+xx] !== id) return true; return false; };
        // ト音記号：五線全体をまたぐ縦長の形
        if(h >= 3.9*s && h <= 9*s && h/w >= 1.8 && dn < 0.5 && y0 < st.ys[0] + 0.2*s && y1 > st.ys[4] - 0.2*s) { clefs.push({x:x0, staff:staves.indexOf(st), clef:'G'}); continue; }
        // ヘ音記号：上半分にあり、右側の第4線をはさんで2つの点がある
        if(h >= 2.2*s && h <= 4.2*s && h/w <= 1.7 && w >= 1.6*s && dn < 0.5 && y0 < st.top + 0.6*s && cy < (st.top+st.bot)/2 + 0.3*s
           && inkBox(x1+1, x1+0.9*s, st.ys[1]-0.75*s, st.ys[1]-0.2*s) && inkBox(x1+1, x1+0.9*s, st.ys[1]+0.2*s, st.ys[1]+0.75*s)) { clefs.push({x:x0, staff:staves.indexOf(st), clef:'F'}); continue; }
      }
      // ---- 休符 ----
      const inStaff = cy > st.top - 0.3*s && cy < st.bot + 0.3*s, dens = qt/(w*h);
      const nearStem = stems.some(t => t.x >= x0 - 3 && t.x <= x1 + 3 && t.y > y0 - 2*s && t.y < y1 + 2*s);
      if(inStaff && !nearStem){
        const si = staves.indexOf(st), mid = st.ys[2];
        let rd = 0;
        if(h >= 0.3*s && h <= 0.75*s && w >= 0.85*s && w <= 1.6*s && dens > 0.75){
          rd = Math.abs(cy - (st.ys[1] + 0.25*s)) < Math.abs(cy - (st.ys[2] - 0.25*s)) ? 4 : 2;   // 全休符（線からぶら下がる）/2分休符（線の上）
        } else if(h >= 1.0*s && h < 1.9*s && w >= 0.5*s && w <= 1.2*s && dens > 0.18 && dens < 0.65 && Math.abs(cy - mid) < 1.2*s){
          rd = 0.5;                                                                                // 8分休符
        } else if(h >= 1.9*s && h < 2.5*s && w >= 0.6*s && w <= 1.4*s && dens > 0.18 && dens < 0.6 && pick(x0,x1).len < 0.6*h){
          rd = 0.25;                                                                               // 16分休符
        } else if(h >= 2.5*s && h <= 3.4*s && w >= 0.6*s && w <= 1.35*s && dens > 0.2 && dens < 0.6 && pick(x0,x1).len < 0.6*h && Math.abs(cy - mid) < 0.8*s){
          rd = 1;                                                                                  // 4分休符
        }
        if(rd){ rests.push({x:(x0+x1)/2, y:cy, staff:si, dur:rd, x0, x1}); continue; }
      }
      if(h < 1.6*s || h > 3.6*s || w < 0.35*s || w > 1.5*s) continue;
      // 左側と右側、それぞれで一番長い縦の連なり（♯は左右とも長い、♮は左が上・右が下にずれる、♭は左だけ長い）
      const cut = Math.max(1, Math.round(w*0.4));
      const Lr = pick(x0, x0+cut-1), Rr = pick(x1-cut+1, x1);
      let type = null;
      // 符頭を消したあとの「符幹＋旗」を♭と間違えない
      if(nearStem) continue;
      if(Lr.len >= 0.55*h && Rr.len >= 0.55*h){
        type = (Lr.top < Rr.top - 0.45*s && Lr.bot < Rr.bot - 0.45*s) ? 'n' : '#';
      } else if(Lr.len >= 0.7*h && Rr.len < 0.45*h){
        let rl = 0, ru = 0;                               // 右側のインクが下半分に偏っている → ♭
        for(let y=y0;y<=y1;y++) for(let x=x0+cut;x<=x1;x++) if(lab[y*W+x] === id){ if(y > y0 + h*0.5) rl++; else ru++; }
        if(rl > 3*ru + 4 && w > 0.45*s) type = 'b';
      }
      if(!type) continue;
      // ♭は下の膨らみの中心、♯♮は中央がその音の高さ
      const py = type === 'b' ? y1 - 0.5*s : cy;
      out.push({type, x0, x1, y0, y1, py, staff: staves.indexOf(st), used:false});
    }
    return {accs: out, rests, clefs};
  }

  /* ---------- 段（システム）と小節線 ---------- */
  function buildSystems(b, W, H, staves, mode){
    if(mode !== 'piano') return staves.map((_,i) => ({staff:[i], bars:[]}));
    const linked = (A, B) => {
      const gap = B.top - A.bot; if(gap <= 0 || gap > 18*A.s) return false;
      const xl = Math.min(A.x0, B.x0);
      for(let x=Math.max(0,xl-6); x<=xl+Math.round(1.5*A.s); x++){
        let n = 0; for(let y=Math.round(A.bot); y<=Math.round(B.top); y++){ const k = y*W+x; if(b[k] || (x>0 && b[k-1]) || b[k+1]) n++; }
        if(n >= 0.92*(B.top - A.bot)) return true;
      }
      return false;
    };
    const sys = []; let i = 0;
    while(i < staves.length){
      const A = staves[i], B = staves[i+1], C = staves[i+2];
      let pair = false;
      if(B){
        if(linked(A, B)) pair = true;
        else { const g1 = B.top - A.bot, g2 = C ? C.top - B.bot : Infinity; pair = g1 < 12*A.s && g2 > g1*1.25; }
      }
      if(pair){ sys.push({staff:[i, i+1], bars:[]}); i += 2; } else { sys.push({staff:[i], bars:[]}); i++; }
    }
    return sys;
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
      const hs = heads.filter(h => sy.staff.includes(h.staff));
      let xs = runs.filter(r => r.b - r.a <= 0.8*s).map(r => (r.a + r.b)/2)
        .filter(x => !hs.some(h => Math.abs(h.x - x) < 0.9*s));
      const merged = []; for(const x of xs){ if(merged.length && x - merged[merged.length-1] < 1.2*s) merged[merged.length-1] = (merged[merged.length-1] + x)/2; else merged.push(x); }
      sy.x0 = x0; sy.x1 = x1; sy.top = top; sy.bot = bot; sy.s = s;
      sy.bars = merged.filter(x => x > x0 + 1.5*s && x < x1 - 1.5*s);
    }
  }

  /* ---------- ページ解析 ---------- */
  async function analyzePage(c0, mode, prog, firstPage){
    prog('画像を2値化しています…'); await yieldUI();
    let G = gray(c0), b = binarize(G);
    prog('傾きを補正しています…'); await yieldUI();
    const ang = skewSlope(b, G.W, G.H);
    let c = c0;
    if(Math.abs(ang) > 0.05){ c = rotateCanvas(c0, ang); G = gray(c); b = binarize(G); }
    const {W, H} = G;
    prog('五線を探しています…'); await yieldUI();
    const staves = findStaves(b, W, H);
    if(!staves.length) return {canvas:c, W, H, staves:[], systems:[], heads:[], rests:[], accs:[], angle:ang};
    const s = staves.map(st=>st.s).sort((a,b)=>a-b)[staves.length>>1];
    prog('音符を探しています…'); await yieldUI();
    const {heads: raw, nb} = detectHeads(b, W, H, s, staves);
    prog('♯・♭を探しています…'); await yieldUI();
    const nb2 = nb.slice();                                 // 符頭を消してから♯♭を探す（くっついていても分かれる）
    for(const h of raw){ const rx = 0.72*s, ry = 0.58*s;
      for(let y=Math.round(h.y-ry); y<=Math.round(h.y+ry); y++) for(let x=Math.round(h.x-rx); x<=Math.round(h.x+rx); x++){
        if(x<0||y<0||x>=W||y>=H) continue; const dx = (x-h.x)/rx, dy = (y-h.y)/ry; if(dx*dx+dy*dy <= 1) nb2[y*W+x] = 0; } }
    const {accs, rests: rests0, clefs} = findAccidentals(nb2, W, H, staves, raw.filter(h => h.stemX != null).map(h => ({x:h.stemX, y:h.y})));
    const systems = buildSystems(b, W, H, staves, mode);
    // 五線に割り当て
    const heads = [];
    for(const h of raw){
      let bi = -1, bd = 1e9;
      staves.forEach((st, i) => { const mid = (st.top + st.bot)/2, dd = Math.abs(h.y - mid); if(h.y > st.top - 5*st.s && h.y < st.bot + 5*st.s && dd < bd){ bd = dd; bi = i; } });
      if(bi < 0) continue;
      const st = staves[bi];
      const step = Math.round((st.bot - h.y) / (st.s/2));
      if(Math.abs(step) > 14 || h.x > st.x1 + st.s) continue;
      heads.push(Object.assign({}, h, {staff:bi, step}));
    }
    // 臨時記号を音符に結びつける（残ったものは調号の候補）
    for(const h of heads){
      const st = staves[h.staff];
      let best = null;
      for(const a of accs){
        if(a.staff !== h.staff || a.used) continue;
        if(a.x1 < h.x - 3.2*st.s || a.x1 > h.x - 0.5*st.s) continue;
        if(Math.abs(a.py - h.y) > 0.45*st.s) continue;
        if(!best || a.x1 > best.x1) best = a;
      }
      if(best){ best.used = true; h.acc = best.type === '#' ? 1 : best.type === 'b' ? -1 : 0; }
    }
    // 小節線（調号の判定にも使う）
    prog('小節線を探しています…'); await yieldUI();
    detectBars(b, W, H, staves, systems, heads);
    // 調号：音符に付いていない ♯♭♮ のまとまり（段の頭、または小節線の直後）
    const keyEv = staves.map(() => []);
    staves.forEach((st, si) => {
      const sy = systems.find(y => y.staff.includes(si));
      const free = accs.filter(a => a.staff === si && !a.used && a.x0 > st.x0 + 2.6*st.s).sort((a,b)=>a.x0-b.x0);   // 音部記号の一部は除く
      const groups = [];
      for(const a of free){ const g = groups[groups.length-1]; if(g && a.x0 - g.x1 < 1.8*st.s){ g.list.push(a); g.x1 = a.x1; } else groups.push({x0:a.x0, x1:a.x1, list:[a]}); }
      for(const g of groups){
        const ns = g.list.filter(a=>a.type==='#').length, nf = g.list.filter(a=>a.type==='b').length;
        const atStart = g.x0 < st.x0 + 12*st.s;
        const afterBar = sy && sy.bars.some(x => g.x0 - x > 0 && g.x0 - x < 4*st.s);
        if(!atStart && !afterBar) continue;
        keyEv[si].push({x0:g.x0, x1:g.x1, key: ns >= nf ? ns : -nf, atStart});
      }
    });
    // ピアノ譜の上段と下段は同じ調：近い位置の調号をそろえる（片方の読み落としを補う）
    for(const sy of systems){ if(sy.staff.length !== 2) continue;
      const [A, B] = sy.staff, s0 = staves[A].s;
      for(const [P, Q] of [[A,B],[B,A]]) for(const e of keyEv[P]){
        const o = keyEv[Q].find(f => Math.abs(f.x0 - e.x0) < 3*s0);
        if(!o) keyEv[Q].push(Object.assign({}, e));
        else if(Math.sign(o.key) === Math.sign(e.key) && Math.abs(e.key) > Math.abs(o.key)) o.key = e.key;
      }
      keyEv[A].sort((a,b)=>a.x0-b.x0); keyEv[B].sort((a,b)=>a.x0-b.x0);
    }
    // 音部記号・調号・拍子記号の領域の音符を除く
    const kept = heads.filter(h => {
      const st = staves[h.staff], ev = keyEv[h.staff].find(e => e.atStart);
      let zone = st.x0 + 4.0*st.s;
      if(ev) zone = Math.max(zone, ev.x1 + 0.6*st.s);
      const sysIdx = systems.findIndex(y => y.staff.includes(h.staff));
      if(firstPage && sysIdx === 0) zone += 2.2*st.s;       // 拍子記号
      return h.x > zone;
    });
    const rests = rests0.filter(r => { const st = staves[r.staff], ev = keyEv[r.staff].find(e => e.atStart);
      let zone = st.x0 + 4.0*st.s; if(ev) zone = Math.max(zone, ev.x1 + 0.6*st.s);
      const sysIdx = systems.findIndex(y => y.staff.includes(r.staff)); if(firstPage && sysIdx === 0) zone += 2.2*st.s;
      return r.x > zone; });
    return {canvas:c, W, H, staves, systems, heads:kept, rests, keyEv, accs, clefs, angle:ang};
  }

  /* ---------- リズム：音符の形（音価）＋間隔から、小節ごとに発音時刻を決める ---------- */
  const U8 = 0.125; // 内部の最小単位（32分音符）
  function measureTiming(cols, L, R, beats, s){
    const n = cols.length; if(!n) return [];
    const U = Math.round(beats/U8);
    const glyph = cols.map(c => c.g);
    const known = glyph.every(g => g);
    if(known && Math.abs(glyph.reduce((a,c)=>a+c,0) - beats) < 1e-6) {
      let t = 0; return glyph.map(g => { const r = t; t += g; return r; });
    }
    const gaps = cols.map((c,i) => i < n-1 ? cols[i+1].x - c.x : Math.max(R - c.x, 0.5*s) + Math.min(cols[0].x - L, 1.5*s));
    const lg = gaps.map(g => Math.log(Math.max(g,1)));
    const COMMON = [0.125,0.25,0.375,0.5,0.75,1,1.5,2,3,4];
    const candOf = i => {
      const g = glyph[i], c = new Map();
      const put = (d, p) => { if(!c.has(d) || c.get(d) > p) c.set(d, p); };
      if(g){ put(g, 0); for(const r of [0.125,0.25,0.5,0.75,1,1.5,2]) put(g+r, 0.9);   // 後ろに休符
        put(g*2, 1.6); if(g/2 >= U8) put(g/2, 1.6); }                                  // 旗・連桁の読み違い
      COMMON.forEach(d => put(d, g ? 2.5 : 0.3));                                        // それ以外（最後の手段）
      return [...c].filter(([d]) => d <= beats + 1e-9 && Math.abs(d/U8 - Math.round(d/U8)) < 1e-6);
    };
    const cands = cols.map((_,i) => candOf(i));
    const mean = lg.reduce((a,c)=>a+c,0)/n - 0.6*Math.log(0.5);
    let best = null, bestCost = Infinity;
    for(let k=-10;k<=10;k++){
      const lc = mean + k*0.12;
      const dp = Array.from({length:n+1}, () => new Float64Array(U+1).fill(Infinity));
      const ch = Array.from({length:n+1}, () => new Int32Array(U+1).fill(-1));
      // 小節の頭に休符がある場合
      for(let u=0; u<U; u++){ dp[0][u] = u === 0 ? 0 : 0.9 + (cols[0].x - L < 2.2*s ? 1.5 : 0); }
      for(let i=0;i<n;i++) for(let u=0;u<=U;u++){
        if(dp[i][u] === Infinity) continue;
        for(const [dd, pen] of cands[i]){
          const du = Math.round(dd/U8), v = u + du; if(v > U) continue;
          if(i < n-1 && v === U) continue;
          const e = lg[i] - lc - 0.6*Math.log(dd);
          const c = dp[i][u] + pen + 0.35*e*e;
          if(c < dp[i+1][v]){ dp[i+1][v] = c; ch[i+1][v] = u; }
        }
      }
      if(dp[n][U] < bestCost){
        bestCost = dp[n][U]; const on = []; let v = U;
        for(let i=n;i>0;i--){ const u = ch[i][v]; on.unshift(u*U8); v = u; }
        best = on;
      }
    }
    if(best) return best;
    return cols.map((c,i) => i*beats/n);   // どうしても合わないとき
  }

  /* ---------- 音の高さ ---------- */
  const WH = [0,2,4,5,7,9,11];
  const SHARP_ORDER = [3,0,4,1,5,2,6], FLAT_ORDER = [6,2,5,1,4,0,3];
  function keyAcc(key){ const a = [0,0,0,0,0,0,0]; if(key > 0) SHARP_ORDER.slice(0,key).forEach(l => a[l] = 1); if(key < 0) FLAT_ORDER.slice(0,-key).forEach(l => a[l] = -1); return a; }
  const diaOf = (step, clef) => (clef === 'F' ? 18 : 30) + step;   // ヘ音:第1線=G2 / ト音:第1線=E4
  function midiOf(d, a){ const l = ((d % 7) + 7) % 7; return 12*(Math.floor(d/7) + 1) + WH[l] + a; }
  function pitchOf(step, clef, acc){ const d = diaOf(step, clef), l = ((d%7)+7)%7; return midiOf(d, acc[l]); }
  const KANA = ['ド','レ','ミ','ファ','ソ','ラ','シ'];
  function nameOfMidi(d, a){ const l = ((d%7)+7)%7; return KANA[l] + (a > 0 ? '♯' : a < 0 ? '♭' : ''); }
  function nameOf(step, clef, acc){ const d = diaOf(step, clef), l = ((d%7)+7)%7; return nameOfMidi(d, acc[l]); }

  /* ---------- 曲データの組み立て ---------- */
  function clefOf(page, staffIdx, mode, x){
    // 楽譜から読み取った音部記号（段の途中の変更も含む）を優先
    const cl = (page.clefs || []).filter(c => c.staff === staffIdx && (x === undefined || c.x < x)).sort((a,b)=>a.x-b.x);
    if(cl.length && mode === 'piano') return cl[cl.length-1].clef;
    if(mode !== 'piano') return mode === 'bass' ? 'F' : 'G';
    const sy = page.systems.find(y => y.staff.includes(staffIdx));
    return sy && sy.staff.length === 2 && sy.staff[1] === staffIdx ? 'F' : 'G';
  }
  function build(pages, opt){
    const out = []; let m = 0;
    const carry = {};                                  // 段をまたいで調号を引き継ぐ（上段/下段ごと）
    for(const pg of pages){
      pg.systems.forEach(sy => {
        const s = sy.s, bounds = [sy.x0, ...sy.bars.slice().sort((a,b)=>a-b), sy.x1];
        const mStart = m;
        sy.staff.forEach((si, role) => {
          const st = pg.staves[si];
          const evs = ((pg.keyEv && pg.keyEv[si]) || []).slice().sort((a,b)=>a.x0-b.x0);
          const keyStart = evs.length && evs[0].atStart ? evs[0].key : (carry[role] ?? 0);
          const keyAt = x => { let k = keyStart; for(const e of evs) if(e.x0 < x) k = e.key; return k; };
          const hsAll = pg.heads.filter(h => h.staff === si);
          let mi = mStart;
          for(let k=0;k<bounds.length-1;k++){
            const L = bounds[k], R = bounds[k+1]; if(R - L < 1.5*s) continue;
            const hs = hsAll.filter(h => h.x > L + 0.3*s && h.x < R - 0.3*s).sort((a,b)=>a.x-b.x);
            // 同じ符幹（和音）または同じ位置の音をまとめる
            const cols = [];
            for(const h of hs){
              const c = cols.find(c => (h.stemX != null && c.stemX != null && Math.abs(h.stemX - c.stemX) < 0.25*s) || Math.abs(h.x - c.x0) < 0.45*s);
              if(c) c.h.push(h); else cols.push({x0:h.x, stemX:h.stemX, h:[h]});
            }
            cols.forEach(c => { c.x = Math.min(...c.h.map(h=>h.x)); const ds = c.h.map(h=>h.dur).filter(Boolean); if(!ds.length) c.g = null; else { const cnt = {}; ds.forEach(v => cnt[v] = (cnt[v]||0) + 1); c.g = +Object.keys(cnt).sort((a,b) => cnt[b]-cnt[a] || b-a)[0]; } });
            // 休符も時間を持つ列として入れる（和音の列と重なるものは除く）
            for(const r of (pg.rests || [])){
              if(r.staff !== si || r.x <= L + 0.3*s || r.x >= R - 0.3*s) continue;
              if(cols.some(c => Math.abs(c.x - r.x) < 0.5*s)) continue;
              const onlyRest = !hs.length && (pg.rests||[]).filter(q => q.staff === si && q.x > L && q.x < R).length === 1;
              cols.push({x:r.x, g: (r.dur === 4 || onlyRest) ? opt.beats : r.dur, h:[], rest:true});
            }
            cols.sort((a,b)=>a.x-b.x);
            const on = measureTiming(cols, L, R, opt.beats, s);
            const measAcc = {};                          // 小節内の臨時記号
            cols.forEach((c, i) => {
              const t = on ? on[i] : i*opt.beats/cols.length;
              for(const h of c.h.slice().sort((a,b)=>a.x-b.x)){
                const clef = clefOf(pg, si, opt.mode, h.x), d = diaOf(h.step, clef), l = ((d%7)+7)%7;
                const key = opt.key === 'auto' ? keyAt(h.x) : opt.key;
                if(h.acc !== undefined) measAcc[d] = h.acc;
                const a = measAcc[d] !== undefined ? measAcc[d] : keyAcc(key)[l];
                h._p = midiOf(d, a); h._name = nameOfMidi(d, a); h._t = mi*opt.beats + t;
                out.push({b: mi*opt.beats + t, p: h._p, tr: sy.staff.length === 2 ? role : (clef === 'F' ? 1 : 0), d: h.dur || 0.5});
              }
            });
            mi++;
          }
          carry[role] = keyAt(Infinity);
          m = Math.max(m, mi);
        });
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
        let dur = n.d ? Math.round(n.d*TP) : (nx !== undefined ? Math.round((nx - n.b)*TP) : TP); dur = Math.max(60, Math.min(dur, TP*4));
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
function scanOpts(){ const k = $('scKey').value; return {mode: $('scMode').value, key: k === 'auto' ? 'auto' : +k, beats: +$('scBeats').value, q: +$('scQ').value}; }
$('scFile').onchange = ev => { SCAN.file = ev.target.files[0] || null; $('scFileName').textContent = SCAN.file ? SCAN.file.name : ''; $('scRun').disabled = !SCAN.file; };
async function scanRun(){
  if(!SCAN.file) return;
  const prog = m => { $('scProg').textContent = m; };
  $('scRun').disabled = true; $('scResult').style.display = 'none';
  try{
    const canvases = await OMR.loadPages(SCAN.file, prog);
    SCAN.pages = [];
    for(let i=0;i<canvases.length;i++){
      const pg = await OMR.analyzePage(canvases[i], $('scMode').value, m => prog(`${i+1}/${canvases.length}ページ：${m}`), i === 0);
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
  const o = scanOpts(), acc = OMR.keyAcc(o.key === 'auto' ? 0 : o.key);
  let svg = `<svg id="scSvg" viewBox="0 0 ${pg.W} ${pg.H}" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%">`;
  for(const st of pg.staves) for(const y of st.ys) svg += `<line x1="${st.x0}" y1="${y}" x2="${st.x1}" y2="${y}" stroke="#3a7bd5" stroke-width="${st.s*0.08}" opacity=".45"/>`;
  for(const sy of pg.systems){
    for(const x of sy.bars) svg += `<line x1="${x}" y1="${sy.top - sy.s}" x2="${x}" y2="${sy.bot + sy.s}" stroke="#2f9e44" stroke-width="${sy.s*0.35}" opacity=".6"/>`;
  }
  for(const r of (pg.rests || [])){ const st = pg.staves[r.staff];
    svg += `<rect x="${r.x - st.s*0.6}" y="${r.y - st.s*0.6}" width="${st.s*1.2}" height="${st.s*1.2}" fill="none" stroke="#f08c00" stroke-width="${st.s*0.15}"/>`; }
  for(const h of pg.heads){
    const st = pg.staves[h.staff], clef = OMR.clefOf(pg, h.staff, o.mode, h.x), sy = pg.systems.find(y => y.staff.includes(h.staff)), lower = sy && sy.staff.length === 2 ? sy.staff[1] === h.staff : clef === 'F', col = lower ? '#1971c2' : '#e03131';
    svg += `<circle cx="${h.x}" cy="${h.y}" r="${st.s*0.62}" fill="none" stroke="${col}" stroke-width="${st.s*0.16}"/>`;
    svg += `<text x="${h.x + st.s*0.7}" y="${h.y - st.s*0.55}" font-size="${st.s*1.05}" fill="${col}" font-weight="700" font-family="sans-serif">${h._name || OMR.nameOf(h.step, clef, acc)}</text>`;
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
    const nearR = (pg.rests || []).map((r,i) => ({i, d: Math.hypot(r.x-x, r.y-y), s: pg.staves[r.staff].s})).sort((a,b)=>a.d-b.d)[0];
    if(nearR && nearR.d < nearR.s*0.9 && (!near || nearR.d < near.d)){ pg.rests.splice(nearR.i, 1); }
    else if(near && near.d < near.s*0.8){ pg.heads.splice(near.i, 1); }
    else {
      let bi = -1, bd = 1e9;
      pg.staves.forEach((st,i) => { const d = Math.abs(y - (st.top+st.bot)/2); if(y > st.top - 5*st.s && y < st.bot + 5*st.s && d < bd){ bd = d; bi = i; } });
      if(bi < 0) return toast('五線の近くをタップしてください');
      const st = pg.staves[bi], step = Math.round((st.bot - y)/(st.s/2));
      pg.heads.push({x, y: st.bot - step*st.s/2, staff: bi, step, hollow:false, dur:null, stemX:null});
      SCAN.added = pg.heads[pg.heads.length-1];
    }
  } else {
    const sy = pg.systems.find(s => y > s.top - 3*s.s && y < s.bot + 3*s.s);
    if(!sy) return toast('段の中をタップしてください');
    const i = sy.bars.findIndex(bx => Math.abs(bx - x) < sy.s);
    if(i >= 0) sy.bars.splice(i, 1); else sy.bars.push(x);
  }
  scanRender();
  if(SCAN.added){ if(SCAN.added._p) beep(SCAN.added._p - 12); SCAN.added = null; }
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
  const tracks = [mk(0,'右手（上の段）'), mk(1,'左手（下の段）')].filter(Boolean);
  openTracksImport('楽譜スキャンから取り込む', scanTitle(), tracks, +$('scBpm').value || 90, +$('scBeats').value);
}

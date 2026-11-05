const CSS = String.raw`
:root{--bg:#f6f6f3;--surface:#fff;--text:#1b1b19;--muted:#6a6a64;--border:#e2e2dc;--accent:#2457d6;--pos:#14703f;--neg:#b42318;--warn:#8a5a00;--grid:#ececE6}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--surface:#1b1b19;--text:#ececE8;--muted:#9c9c94;--border:#2d2d29;--accent:#7aa2ff;--pos:#4cc38a;--neg:#ff7b72;--warn:#e3b341;--grid:#262623}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header,main,footer,#banner{max-width:960px;margin:0 auto;padding:0 16px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding-top:20px;padding-bottom:8px}
h1{font-size:1.25rem;margin:0}
h2{font-size:1rem;margin:28px 0 10px}
.controls{display:flex;gap:8px;align-items:center;color:var(--muted)}
select{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:6px 10px}
#banner{margin-top:6px;margin-bottom:6px;min-height:1.4em;color:var(--muted);font-size:.9rem}
#banner.err{color:var(--neg)}#banner.warn{color:var(--warn)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px 14px}
.card .label{color:var(--muted);font-size:.8rem}
.card .value{font-size:1.35rem;font-weight:650;font-variant-numeric:tabular-nums;margin-top:2px}
.card .sub{color:var(--muted);font-size:.8rem;margin-top:2px}
.pos{color:var(--pos)}.neg{color:var(--neg)}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px}
.legend{display:flex;gap:16px;flex-wrap:wrap;color:var(--muted);font-size:.85rem;margin-bottom:6px}
.legend span::before{content:"";display:inline-block;width:18px;height:0;border-top:3px solid var(--accent);vertical-align:middle;margin-right:6px}
.legend span.bh::before{border-top:3px dashed var(--muted)}
svg{width:100%;height:auto;display:block}
.axis,.tick{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.gridline{stroke:var(--grid);stroke-width:1}
.line-strat{fill:none;stroke:var(--accent);stroke-width:2.2;stroke-linejoin:round}
.line-bh{fill:none;stroke:var(--muted);stroke-width:1.8;stroke-dasharray:5 4;stroke-linejoin:round}
.dot-strat{fill:var(--accent)}.dot-bh{fill:var(--muted)}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:.9rem}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
th{color:var(--muted);font-weight:600;font-size:.8rem;position:sticky;top:0;background:var(--surface)}
.tall{max-height:420px;overflow:auto}
td.num,th.num{text-align:right}
ul{margin:0;padding-left:18px;color:var(--muted);font-size:.9rem}
.empty{color:var(--muted)}
footer{color:var(--muted);font-size:.8rem;padding-top:28px;padding-bottom:32px}
code{background:var(--surface);border:1px solid var(--border);border-radius:5px;padding:1px 5px}
`;

// Pas de backticks ni de « ${ » dans ce script : il est inséré tel quel dans un gabarit.
// Toutes les données sont écrites avec textContent, jamais avec innerHTML.
const JS = String.raw`
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var REFRESH_MS = 10000;
  var current = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function svgEl(tag, attrs, text) {
    var e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function usd(x) {
    if (x === null || x === undefined) return "—";
    return x.toLocaleString("fr-FR", { style: "currency", currency: "USD" });
  }
  function num(x, d) { return x === null || x === undefined ? "—" : x.toLocaleString("fr-FR", { maximumFractionDigits: d }); }
  function pct(x) {
    if (x === null || x === undefined) return "—";
    return (x > 0 ? "▲ +" : x < 0 ? "▼ " : "") + x.toFixed(2).replace(".", ",") + " %";
  }
  function cls(x) { return x > 0 ? "pos" : x < 0 ? "neg" : ""; }
  function when(iso) {
    var d = new Date(iso);
    return isNaN(d) ? "—" : d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  function ago(iso) {
    var s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 90) return s + " s";
    if (s < 5400) return Math.round(s / 60) + " min";
    if (s < 172800) return Math.round(s / 3600) + " h";
    return Math.round(s / 86400) + " j";
  }
  function banner(text, kind) { var b = $("banner"); b.textContent = text; b.className = kind || ""; }

  function api(path) {
    return fetch(path, { cache: "no-store" }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) {
        if (!r.ok) throw new Error(b.error || ("HTTP " + r.status));
        return b;
      });
    });
  }

  function card(label, value, sub, c) {
    var d = el("div", "card");
    d.appendChild(el("div", "label", label));
    d.appendChild(el("div", "value" + (c ? " " + c : ""), value));
    if (sub) d.appendChild(el("div", "sub", sub));
    return d;
  }

  function renderKpis(d) {
    var s = d.status, box = $("kpis");
    clear(box);
    box.appendChild(card("Capital", usd(s.equity), pct(s.returnPct) + " depuis le départ", cls(s.returnPct)));
    box.appendChild(card("Acheter-garder", pct(s.buyHoldReturnPct), "même période, mêmes coûts d'entrée", cls(s.buyHoldReturnPct)));
    box.appendChild(card("Dernier prix", usd(s.lastPrice), s.symbol + " · " + s.strategy));
    box.appendChild(card("Position", s.openPosition ? "Ouverte" : "À plat", "prochain ordre : " + s.pending));
    box.appendChild(card("Allers-retours", String(s.roundTrips), s.winRate === null ? "aucun terminé" : Math.round(s.winRate * 100) + " % gagnants"));
    box.appendChild(card("Frais payés", usd(s.feesPaid), s.trades + " trade(s)"));
    box.appendChild(card("Prix reçus", String(s.ticks), s.skipped + " refusé(s)", s.skipped > 0 ? "" : ""));
  }

  function drawChart(series) {
    var svg = $("chart");
    clear(svg);
    if (series.length < 2) {
      svg.setAttribute("viewBox", "0 0 720 80");
      svg.appendChild(svgEl("text", { x: 12, y: 44, class: "axis" }, "Pas encore assez de données (il faut au moins 2 prix)."));
      svg.setAttribute("aria-label", "Graphique indisponible : pas assez de données");
      return;
    }
    var avail = svg.parentNode.clientWidth - 24;
    var W = Math.max(300, Math.min(720, avail > 0 ? avail : 720));
    var H = W < 480 ? 230 : 280, L = W < 480 ? 58 : 70, R = 12, T = 12, B = 30;
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    var times = series.map(function (p) { return new Date(p.t).getTime(); });
    var t0 = times[0], t1 = times[times.length - 1];
    var vals = [];
    series.forEach(function (p) { vals.push(p.equity); if (p.buyHold !== null) vals.push(p.buyHold); });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
    var pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    function X(t) { return t1 === t0 ? (L + W - R) / 2 : L + (t - t0) / (t1 - t0) * (W - L - R); }
    function Y(v) { return T + (hi - v) / (hi - lo) * (H - T - B); }

    for (var i = 0; i <= 4; i++) {
      var v = lo + (hi - lo) * i / 4, y = Y(v);
      svg.appendChild(svgEl("line", { x1: L, x2: W - R, y1: y, y2: y, class: "gridline" }));
      svg.appendChild(svgEl("text", { x: L - 8, y: y + 4, "text-anchor": "end", class: "tick" }, num(v, (hi - lo) > 20 ? 0 : 2)));
    }
    svg.appendChild(svgEl("text", { x: L, y: H - 8, class: "axis" }, when(series[0].t)));
    svg.appendChild(svgEl("text", { x: W - R, y: H - 8, "text-anchor": "end", class: "axis" }, when(series[series.length - 1].t)));

    function line(key, klass) {
      var pts = [];
      series.forEach(function (p, i) { if (p[key] !== null) pts.push(X(times[i]).toFixed(1) + "," + Y(p[key]).toFixed(1)); });
      if (pts.length) svg.appendChild(svgEl("polyline", { points: pts.join(" "), class: klass }));
    }
    line("buyHold", "line-bh");
    line("equity", "line-strat");
    var last = series[series.length - 1];
    svg.appendChild(svgEl("circle", { cx: X(t1), cy: Y(last.equity), r: 4, class: "dot-strat" }));
    if (last.buyHold !== null) svg.appendChild(svgEl("circle", { cx: X(t1), cy: Y(last.buyHold), r: 3.5, class: "dot-bh" }));
    svg.setAttribute("aria-label", "Capital de la stratégie : de " + usd(series[0].equity) + " à " + usd(last.equity) +
      (last.buyHold !== null ? ", acheter-garder : " + usd(last.buyHold) : ""));
  }

  function row(table, cells, head) {
    var tr = el("tr");
    cells.forEach(function (c) {
      var td = el(head ? "th" : "td", c.num ? "num" : "", c.text);
      if (head) td.setAttribute("scope", "col");
      if (c.cls) td.className += " " + c.cls;
      tr.appendChild(td);
    });
    table.appendChild(tr);
  }

  function renderTrades(trades) {
    var t = $("trades");
    clear(t);
    if (!trades.length) { var p = el("p", "empty", "Aucun trade pour l'instant."); t.appendChild(p); return; }
    row(t, [{ text: "Heure" }, { text: "Sens" }, { text: "Prix obtenu", num: true }, { text: "Quantité", num: true }, { text: "Frais", num: true }], true);
    trades.forEach(function (x) {
      row(t, [
        { text: when(x.t) },
        { text: x.side === "buy" ? "Achat" : "Vente", cls: x.side === "buy" ? "pos" : "neg" },
        { text: usd(x.price), num: true },
        { text: num(x.qty, 6), num: true },
        { text: usd(x.feeUsd), num: true }
      ]);
    });
  }

  function renderSkipped(list) {
    var u = $("skipped");
    clear(u);
    if (!list.length) { u.appendChild(el("li", "", "Aucun.")); return; }
    list.forEach(function (x) { u.appendChild(el("li", "", when(x.t) + " — " + x.reason)); });
  }

  function renderGuard(g) {
    var sec = $("guardSec"), t = $("guard");
    clear(t);
    if (!g.rows.length) { sec.hidden = true; return; }
    sec.hidden = false;
    row(t, [{ text: "Heure" }, { text: "Événement" }, { text: "Destinataire" }, { text: "Montant (wei)", num: true }, { text: "Raison" }], true);
    g.rows.slice(0, 15).forEach(function (r) {
      row(t, [
        { text: when(r.t) },
        { text: String(r.event), cls: r.event === "denied" ? "neg" : "" },
        { text: r.to ? String(r.to).slice(0, 10) + "…" : "—" },
        { text: r.valueWei === undefined ? "—" : String(r.valueWei), num: true },
        { text: r.reason ? String(r.reason) : "" }
      ]);
    });
  }

  var lastSeries = [];
  var resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { drawChart(lastSeries); }, 150);
  });

  function render(d) {
    lastSeries = d.series;
    $("main").hidden = false;
    renderKpis(d);
    drawChart(d.series);
    renderTrades(d.trades);
    renderSkipped(d.skipped);
    if (d.lastTickAt) {
      var age = (Date.now() - new Date(d.lastTickAt).getTime()) / 1000;
      if (age > 300) banner("Dernier prix reçu il y a " + ago(d.lastTickAt) + " : le mode papier tourne-t-il encore ?", "warn");
      else banner("Dernier prix reçu il y a " + ago(d.lastTickAt) + " · rafraîchi toutes les 10 s", "");
    } else {
      banner("Aucun prix reçu pour l'instant.", "warn");
    }
  }

  function fillSelect(symbols) {
    var sel = $("symbol");
    var have = Array.prototype.map.call(sel.options, function (o) { return o.value; }).join(",");
    if (have !== symbols.join(",")) {
      clear(sel);
      symbols.forEach(function (s) { var o = el("option", "", s); o.value = s; sel.appendChild(o); });
    }
    if (!current || symbols.indexOf(current) < 0) current = symbols[0];
    sel.value = current;
  }

  function refresh() {
    api("/api/symbols").then(function (s) {
      if (!s.symbols.length) {
        $("main").hidden = true;
        banner("Aucune donnée. Lancez le mode papier : npm run paper", "warn");
        return null;
      }
      fillSelect(s.symbols);
      return api("/api/paper/" + encodeURIComponent(current)).then(render).then(function () {
        return api("/api/guard").then(renderGuard);
      });
    }).catch(function (e) { banner("Erreur : " + e.message, "err"); });
  }

  $("symbol").addEventListener("change", function (e) { current = e.target.value; refresh(); });
  refresh();
  setInterval(refresh, REFRESH_MS);
})();
`;

export function renderPage(nonce: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mode papier</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<header>
  <h1>Mode papier</h1>
  <div class="controls"><label for="symbol">Actif</label><select id="symbol"></select></div>
</header>
<p id="banner" role="status" aria-live="polite">Chargement…</p>
<main id="main" hidden>
  <section aria-label="Indicateurs"><div class="kpis" id="kpis"></div></section>
  <section>
    <h2>Capital au fil du temps</h2>
    <div class="panel">
      <div class="legend"><span>Stratégie</span><span class="bh">Acheter-garder</span></div>
      <svg id="chart" role="img" aria-label="Graphique du capital" viewBox="0 0 720 280"></svg>
    </div>
  </section>
  <section><h2>Derniers trades</h2><div class="panel scroll tall"><table id="trades"></table></div></section>
  <section><h2>Prix refusés (périmés, trop incertains ou erreur réseau)</h2><div class="panel"><ul id="skipped"></ul></div></section>
  <section id="guardSec" hidden><h2>Journal du garde-fou (testnet)</h2><div class="panel scroll"><table id="guard"></table></div></section>
</main>
<footer>Lecture seule · aucune transaction · données locales du dossier <code>data/</code></footer>
<script nonce="${nonce}">${JS}</script>
</body>
</html>`;
}

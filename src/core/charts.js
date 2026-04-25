// Chart helpers — uPlot sparklines / line charts with SVG fallback.

import { vendor } from "./vendor.js";

/**
 * Render a sparkline. `series` = array of numbers (oldest → newest).
 * Returns an HTMLElement that is updated asynchronously when uPlot loads.
 */
export function sparkline(series, { width = 300, height = 60, label = "" } = {}) {
  const host = document.createElement("div");
  host.className = "spark";
  host.style.width = width + "px";
  host.style.height = height + "px";
  // Synchronous SVG fallback so something shows before uPlot loads.
  host.append(svgSpark(series, width, height));
  (async () => {
    try {
      const uPlotCtor = await vendor.uplot();
      if (!uPlotCtor) return;
      host.replaceChildren(); // clear fallback
      const x = series.map((_, i) => i);
      const data = [x, series];
      const opts = {
        width, height,
        scales: { x: { time: false } },
        axes: [ { show: false }, { show: false } ],
        legend: { show: false },
        cursor: { drag: { x: false, y: false } },
        series: [
          {},
          { stroke: "rgb(56,189,248)", width: 1.5, fill: "rgba(56,189,248,0.12)" },
        ],
      };
      new uPlotCtor(opts, data, host);
    } catch { /* keep SVG fallback */ }
  })();
  return host;
}

function svgSpark(series, W, H) {
  if (!series.length) {
    const empty = document.createElement("div");
    empty.className = "tiny muted";
    empty.textContent = "no data";
    return empty;
  }
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  const min = Math.min(...series), max = Math.max(...series);
  const span = max - min || 1;
  const points = series.map((v, i) => {
    const x = (i / (series.length - 1 || 1)) * W;
    const y = H - ((v - min) / span) * (H - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  svg.innerHTML = `<polyline points="${points}" fill="none" stroke="rgb(56,189,248)" stroke-width="1.5"/>`;
  return svg;
}

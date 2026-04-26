// Chart helpers — ECharts visualizations plus uPlot sparklines with SVG fallback.

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

export function historianChart(samples, { title = "", unit = "", type = "line", width = "100%", height = 280 } = {}) {
  const host = document.createElement("div");
  host.className = "historian-chart";
  host.style.width = typeof width === "number" ? width + "px" : width;
  host.style.height = typeof height === "number" ? height + "px" : height;
  const values = samples.map(s => Number(s.value)).filter(Number.isFinite);
  host.append(svgSpark(values, 640, 220));
  (async () => {
    try {
      const echarts = await vendor.echarts();
      if (!echarts) return;
      host.replaceChildren();
      const chart = echarts.init(host, null, { renderer: "canvas" });
      const data = samples.map((s, i) => [s.ts || i, Number(s.value)]);
      const seriesType = type === "area" ? "line" : type;
      chart.setOption({
        backgroundColor: "transparent",
        color: ["#38bdf8"],
        title: { text: title, left: 8, top: 4, textStyle: { color: "#e5edf7", fontSize: 12, fontWeight: 600 } },
        grid: { left: 42, right: 18, top: 42, bottom: 42 },
        tooltip: { trigger: "axis", valueFormatter: v => `${Number(v).toFixed(2)} ${unit}`.trim() },
        xAxis: { type: "time", axisLabel: { color: "#94a3b8" }, axisLine: { lineStyle: { color: "#334155" } }, splitLine: { show: false } },
        yAxis: { type: "value", name: unit, nameTextStyle: { color: "#94a3b8" }, axisLabel: { color: "#94a3b8" }, splitLine: { lineStyle: { color: "rgba(148,163,184,0.16)" } } },
        series: [{
          name: title || "value",
          type: seriesType,
          data,
          symbolSize: type === "scatter" ? 8 : 4,
          showSymbol: type === "scatter",
          smooth: type === "line" || type === "area",
          areaStyle: type === "area" ? { opacity: 0.18 } : undefined,
          barMaxWidth: 18,
        }],
      });
      setTimeout(() => chart.resize(), 0);
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

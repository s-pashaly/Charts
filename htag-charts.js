/**
 * HtAG suburb-page charts — Price (forecast) + Rent
 * --------------------------------------------------
 * Redesigned UI: clean line + gradient fill + complementary bars.
 *
 * Requires: Chart.js 4.4+
 *           chartjs-plugin-deferred (optional — auto-registers if loaded)
 *
 * Globals expected from WordPress (set by inline <script> before this file):
 *   typeParameter            — "Houses" | "Units"   (initial unit)
 *   forecastChart            — URL to price JSON
 *   rentChart                — URL to rent JSON
 *   fiveYearBtnFilterHistory — initial x-axis min for price (e.g. "2020-01")
 *   fiveYearBtnFilterRent    — initial x-axis min for rent
 *
 * Public hooks (preserved for inline onClick handlers in the WP markup):
 *   forecastInfo(unit)       — switch Houses/Units on price chart
 *   choose(xMin)             — set price chart x-axis min ("2020-01" etc.)
 *   sourceForecastInfo(url)  — repoint price chart to a new JSON source
 *   rentInfo(unit)           — switch Houses/Units on rent chart
 *   chooseRent(xMin)         — set rent chart x-axis min
 *   sourceInfoRent(url)      — repoint rent chart to a new JSON source
 */
(function () {
  'use strict';

  Chart.defaults.font.family =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif';
  Chart.defaults.font.size = 11;
  Chart.defaults.color = '#64748b';

  // ────────────────────────────────────────────────────────────
  // Shared utilities
  // ────────────────────────────────────────────────────────────

  const _jsonCache = new Map();
  function fetchJSON(url) {
    if (!_jsonCache.has(url)) {
      _jsonCache.set(
        url,
        fetch(url).then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
          return r.json();
        })
      );
    }
    return _jsonCache.get(url);
  }

  const fmtThousands = n => Number(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  function fmtAxisCurrency(value) {
    if (value >= 1e6) return `$${+(value / 1e6).toFixed(1)}M`;
    if (value >= 1e3) return `$${Math.round(value / 1e3)}K`;
    return `$${value}`;
  }

  const arrayMin = arr => Math.min(...arr.filter(v => v != null));
  const stripDay = s => s.slice(0, -3);

  function setPanel(ids, state) {
    const display = {
      loading:  ['flex',  'none',  'none' ],
      'no-data':['none',  'flex',  'none' ],
      chart:    ['none',  'none',  'block'],
    }[state];
    [ids.loading, ids.noData, ids.chart].forEach((id, i) => {
      const el = document.getElementById(id);
      if (el) el.style.display = display[i];
    });
  }

  // Vertical gradient under the line, recomputed against the live chartArea.
  function makeLineGradient(chartCtx, theme) {
    const { chart } = chartCtx;
    const area = chart.chartArea;
    if (!area) return theme.fillFallback || 'rgba(0,0,0,0)';
    const g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
    g.addColorStop(0,   theme.fillTop);
    g.addColorStop(0.6, theme.fillMid || theme.fillTop);
    g.addColorStop(1,   theme.fillBottom);
    return g;
  }

  // ────────────────────────────────────────────────────────────
  // Plugin — washes out the forecast region (anything after `cutoffLabel`).
  // Draws a translucent veil + a faint vertical divider over the right side
  // of the chart so the line, gradient, bars and BR series read as
  // "this is an estimate".
  // ────────────────────────────────────────────────────────────
  const forecastVeilPlugin = {
    id: 'forecastVeil',
    afterDatasetsDraw(chart, _args, opts) {
      if (!opts || !opts.cutoffLabel) return;
      const labels = chart.data.labels || [];
      const idx = labels.findIndex(l => l > opts.cutoffLabel);
      if (idx <= 0) return;

      const { ctx, chartArea, scales } = chart;
      const xScale = scales.x;
      const prevX = xScale.getPixelForValue(idx - 1);
      const currX = xScale.getPixelForValue(idx);
      let left = (prevX + currX) / 2;
      left = Math.max(left, chartArea.left);
      if (left >= chartArea.right) return;

      ctx.save();
      ctx.fillStyle = opts.color || 'rgba(255,255,255,0.55)';
      ctx.fillRect(left, chartArea.top, chartArea.right - left, chartArea.bottom - chartArea.top);

      if (opts.divider) {
        ctx.strokeStyle = opts.divider;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(left + 0.5, chartArea.top);
        ctx.lineTo(left + 0.5, chartArea.bottom);
        ctx.stroke();
      }
      ctx.restore();
    },
  };
  if (typeof Chart !== 'undefined') Chart.register(forecastVeilPlugin);

  // ────────────────────────────────────────────────────────────
  // Chart factory — shared between Price and Rent
  // ────────────────────────────────────────────────────────────

  /**
   * @param {Object} cfg
   * @param {string} cfg.canvasId       <canvas> id
   * @param {string} cfg.loadingId      loading-state element id
   * @param {string} cfg.noDataId       no-data element id
   * @param {string} cfg.sourceUrl      JSON URL
   * @param {string} cfg.defaultUnit    "Houses" | "Units"
   * @param {string} cfg.defaultXMin    initial x-axis min
   * @param {{line,bar:string}} cfg.labels
   * @param {{stepSize:number, minFn:(m:number)=>number}} cfg.yAxis
   * @param {Object} cfg.theme          { line, fillTop, fillMid, fillBottom, bar, barFuture, barHover }
   */
  function createMetricChart(cfg) {
    const panelIds = { loading: cfg.loadingId, noData: cfg.noDataId, chart: cfg.canvasId };
    const theme = cfg.theme;

    const state = {
      unit: cfg.defaultUnit,
      xMin: cfg.defaultXMin,
      sourceUrl: cfg.sourceUrl,
      chart: null,
    };

    const isPremium       = () => state.sourceUrl.includes('premium');
    const isFuturePoint   = (ctx, n) => isPremium() && ctx.dataIndex   > ctx.chart.data.datasets[ctx.datasetIndex].data.length - n;
    const isFutureSegment = (ctx, n) => isPremium() && ctx.p0DataIndex > ctx.chart.data.datasets[ctx.datasetIndex].data.length - n;

    async function render() {
      const canvas = document.getElementById(cfg.canvasId);
      if (!canvas) return;

      setPanel(panelIds, 'loading');

      let data;
      try {
        data = await fetchJSON(state.sourceUrl);
      } catch (err) {
        console.error(`[${cfg.canvasId}]`, err);
        setPanel(panelIds, 'no-data');
        return;
      }

      const block = data?.[state.unit];
      const sample = block && (block.BR1 ?? block.BR2 ?? block.BR3 ?? block.BR4 ?? block.BR5 ?? block.BR0);
      if (!sample || !sample.length) {
        setPanel(panelIds, 'no-data');
        return;
      }

      const yMin   = cfg.yAxis.minFn(arrayMin(sample));
      const labels = data.years.map(stripDay);

      const datasets = [
        // 0: Main line with gradient fill below
        {
          type: 'line',
          label: cfg.labels.line,
          data: block.BR0,
          yAxisID: 'y1',
          borderColor: theme.line,
          borderWidth: 2.5,
          borderCapStyle: 'round',
          borderJoinStyle: 'round',
          backgroundColor: ctx => makeLineGradient(ctx, theme),
          fill: 'start',
          tension: 0.35,
          spanGaps: true,
          pointRadius: 0,
          pointHoverRadius: ctx => (isFuturePoint(ctx, 24) ? 0 : 4),
          pointHoverBackgroundColor: theme.line,
          pointHoverBorderColor: '#fff',
          pointHoverBorderWidth: 2,
          pointHitRadius: 8,
          segment: {
            borderColor: ctx => (isFutureSegment(ctx, 25) ? 'rgba(0,0,0,0)' : theme.line),
            borderDash:  ctx => (isFutureSegment(ctx, 25) ? [4, 4] : undefined),
          },
          order: 1,
        },
        // 1: Volume bars — kept subtle so they don't compete with the line
        {
          type: 'bar',
          label: cfg.labels.bar,
          data: block.MA_CNT,
          yAxisID: 'y',
          backgroundColor: ctx => (isFuturePoint(ctx, 24) ? theme.barFuture : theme.bar),
          hoverBackgroundColor: theme.barHover,
          borderColor: 'transparent',
          borderRadius: 2,
          borderSkipped: false,
          maxBarThickness: 8,
          categoryPercentage: 0.8,
          barPercentage: 0.85,
          order: 2,
        },
      ];

      // 2+: bedroom-count series (BR1..BR8) — shown by default in a softer
      // tone so they sit underneath the main line as context
      const brDatasets = Object.keys(block)
        .filter(k => /^BR[1-8]$/.test(k))
        .map(key => ({
          type: 'line',
          label: key,
          data: block[key],
          yAxisID: 'y1',
          fill: false,
          borderDash: [3, 3],
          borderColor: theme.brLine || theme.line,
          borderWidth: 1.25,
          hidden: false,
          tension: 0.35,
          pointRadius: 0,
          pointHoverRadius: 3,
          pointHitRadius: 6,
          segment: {
            borderColor: ctx => (isFutureSegment(ctx, 25) ? 'rgba(0,0,0,0)' : (theme.brLine || theme.line)),
          },
          order: 3,
        }));

      datasets.push(...brDatasets);

      // Tooltip: bar dataset is a count (plain integer), everything else is currency
      const BAR_INDEX = 1;
      const tooltipLabel = ctx => {
        const label = ctx.dataset.label || '';
        if (ctx.parsed.y == null) return label;
        const prefix = ctx.datasetIndex === BAR_INDEX ? '' : '$';
        return `${label}: ${prefix}${fmtThousands(ctx.parsed.y)}`;
      };

      if (state.chart) state.chart.destroy();

      state.chart = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: { labels, datasets },
        options: {
          maintainAspectRatio: false,
          responsive: true,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            deferred: { xOffset: 150, yOffset: '50%', delay: 400 },
            title:    { display: false },
            forecastVeil: {
              cutoffLabel: '2026-12',
              color:   'rgba(255,255,255,0.55)',
              divider: 'rgba(15,23,42,0.18)',
            },
            tooltip: {
              callbacks: { label: tooltipLabel },
              backgroundColor: 'rgba(15,23,42,0.95)',
              titleColor: '#fff',
              bodyColor: '#e2e8f0',
              borderColor: 'rgba(255,255,255,0.06)',
              borderWidth: 1,
              padding: 10,
              cornerRadius: 8,
              displayColors: true,
              boxWidth: 8,
              boxHeight: 8,
              boxPadding: 4,
              titleFont: { size: 11, weight: '600' },
              bodyFont:  { size: 11 },
            },
            legend: { display: false },
          },
          scales: {
            x: {
              min: state.xMin,
              grid: { display: false },
              border: { display: false },
              ticks: {
                color: '#94a3b8',
                maxRotation: 0,
                autoSkipPadding: 18,
                font: { size: 10 },
              },
            },
            y: {
              display: false,
              type: 'linear',
              position: 'left',
              beginAtZero: true,
              grid: { display: false },
              border: { display: false },
              ticks: { display: false },
            },
            y1: {
              display: true,
              type: 'linear',
              position: 'right',
              min: yMin,
              border: { display: false },
              grid: {
                color: 'rgba(148,163,184,0.18)',
                lineWidth: 1,
                drawTicks: false,
                drawOnChartArea: true,
              },
              ticks: {
                stepSize: cfg.yAxis.stepSize,
                callback: fmtAxisCurrency,
                color: '#94a3b8',
                padding: 8,
                font: { size: 10 },
              },
              afterBuildTicks: axis => {
                // dashed gridlines effect via segment overrides isn't supported,
                // but the soft colour above gives the same airy feel.
              },
            },
          },
          animation: { duration: 700, easing: 'easeOutCubic' },
          animations: {
            colors: false,
            x: { duration: 0 },
          },
          layout: { padding: { top: 8, right: 4, bottom: 0, left: 4 } },
        },
      });

      setPanel(panelIds, 'chart');
    }

    return {
      render,
      setUnit:   unit => { state.unit = unit; return render(); },
      setSource: url  => { state.sourceUrl = url; return render(); },
      setXMin:   xMin => {
        if (!state.chart) return;
        const labels = state.chart.data.labels;
        state.xMin = labels.includes(xMin) ? xMin : undefined;
        state.chart.options.scales.x.min = state.xMin;
        state.chart.update();
      },
    };
  }

  // ────────────────────────────────────────────────────────────
  // Themes
  // ────────────────────────────────────────────────────────────

  const BLUE = {
    line:        '#2563eb',
    fillTop:     'rgba(37,99,235,0.32)',
    fillMid:     'rgba(37,99,235,0.10)',
    fillBottom:  'rgba(37,99,235,0)',
    brLine:      'rgba(37,99,235,0.40)',
    bar:         'rgba(96,165,250,0.22)',
    barHover:    'rgba(37,99,235,0.65)',
    barFuture:   'rgba(96,165,250,0.10)',
  };

  const GREEN = {
    line:        '#16a34a',
    fillTop:     'rgba(22,163,74,0.30)',
    fillMid:     'rgba(22,163,74,0.10)',
    fillBottom:  'rgba(22,163,74,0)',
    brLine:      'rgba(22,163,74,0.40)',
    bar:         'rgba(74,222,128,0.22)',
    barHover:    'rgba(22,163,74,0.65)',
    barFuture:   'rgba(74,222,128,0.10)',
  };

  // ────────────────────────────────────────────────────────────
  // Price (forecast) chart
  // ────────────────────────────────────────────────────────────

  if (document.getElementById('forecastChart')) {
    const priceChart = createMetricChart({
      canvasId:    'forecastChart',
      loadingId:   'loading',
      noDataId:    'no-dataForecast',
      sourceUrl:   window.forecastChart,
      defaultUnit: window.typeParameter ?? 'Houses',
      defaultXMin: window.fiveYearBtnFilterHistory,
      labels: { line: 'Typical price', bar: 'Sales' },
      yAxis:  { stepSize: 200000, minFn: m => Math.floor(m / 10000) * 10000 - 50000 },
      theme:  BLUE,
    });

    window.forecastInfo       = unit => priceChart.setUnit(unit);
    window.choose             = xMin => priceChart.setXMin(xMin);
    window.sourceForecastInfo = url  => priceChart.setSource(url);

    document.addEventListener('DOMContentLoaded', () => priceChart.render());
  }

  // ────────────────────────────────────────────────────────────
  // Rent chart
  // ────────────────────────────────────────────────────────────

  if (document.getElementById('rentChart')) {
    const rentChartInstance = createMetricChart({
      canvasId:    'rentChart',
      loadingId:   'loading-rent',
      noDataId:    'no-dataRent',
      sourceUrl:   window.rentChart,
      defaultUnit: window.typeParameter ?? 'Houses',
      defaultXMin: window.fiveYearBtnFilterRent,
      labels: { line: 'Median Rent', bar: 'Rentals' },
      yAxis:  { stepSize: 200, minFn: m => Math.floor(m / 100) * 100 - 50 },
      theme:  GREEN,
    });

    window.rentInfo       = unit => rentChartInstance.setUnit(unit);
    window.chooseRent     = xMin => rentChartInstance.setXMin(xMin);
    window.sourceInfoRent = url  => rentChartInstance.setSource(url);

    document.addEventListener('DOMContentLoaded', () => rentChartInstance.render());
  }
})();

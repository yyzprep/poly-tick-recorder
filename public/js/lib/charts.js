/**
 * Chart helpers — wraps TradingView lightweight-charts.
 */
const Charts = {
  /**
   * Create a bid/ask line chart for session tick data.
   */
  createSessionChart(container, ticks, options = {}) {
    container.innerHTML = '';

    const chart = LightweightCharts.createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight || 400,
      layout: {
        background: { color: '#111827' },
        textColor: '#8892a4',
      },
      grid: {
        vertLines: { color: '#1e2a3a' },
        horzLines: { color: '#1e2a3a' },
      },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: '#1e2a3a',
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: '#1e2a3a',
        timeVisible: true,
        secondsVisible: true,
      },
    });

    // Ask (YES) line — green
    const askSeries = chart.addLineSeries({
      color: '#22c55e',
      lineWidth: 2,
      title: 'YES (Ask)',
    });

    // Bid (NO) line — red
    const bidSeries = chart.addLineSeries({
      color: '#ef4444',
      lineWidth: 2,
      title: 'NO (Bid)',
    });

    const askData = ticks.map(t => ({ time: t.t, value: t.ask }));
    const bidData = ticks.map(t => ({ time: t.t, value: t.bid }));

    askSeries.setData(askData);
    bidSeries.setData(bidData);
    chart.timeScale().fitContent();

    // Responsive
    const resizeObserver = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth });
    });
    resizeObserver.observe(container);

    return { chart, askSeries, bidSeries, resizeObserver };
  },

  /**
   * Create an equity curve chart.
   */
  createEquityChart(container, equityCurve, initialBalance) {
    container.innerHTML = '';

    const chart = LightweightCharts.createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight || 250,
      layout: {
        background: { color: '#111827' },
        textColor: '#8892a4',
      },
      grid: {
        vertLines: { color: '#1e2a3a' },
        horzLines: { color: '#1e2a3a' },
      },
      rightPriceScale: { borderColor: '#1e2a3a' },
      timeScale: { borderColor: '#1e2a3a', timeVisible: true, secondsVisible: true },
    });

    const series = chart.addLineSeries({
      color: '#3b82f6',
      lineWidth: 2,
      title: 'Equity',
    });

    // Baseline at initial balance
    const baseline = chart.addLineSeries({
      color: '#8892a4',
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      title: 'Start',
    });

    const data = equityCurve.map(e => ({ time: e.t, value: e.equity }));
    series.setData(data);

    if (data.length > 0) {
      baseline.setData([
        { time: data[0].time, value: initialBalance },
        { time: data[data.length - 1].time, value: initialBalance },
      ]);
    }

    chart.timeScale().fitContent();

    const resizeObserver = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth });
    });
    resizeObserver.observe(container);

    return { chart, series, resizeObserver };
  },

  /**
   * Add trade markers to a session chart.
   */
  addTradeMarkers(askSeries, trades) {
    const markers = trades.map(t => ({
      time: t.timestamp,
      position: t.action === 'BUY' ? 'belowBar' : 'aboveBar',
      color: t.side === 'YES' ? '#22c55e' : '#ef4444',
      shape: t.action === 'BUY' ? 'arrowUp' : 'arrowDown',
      text: `${t.action} ${t.side} x${t.size}`,
    }));

    // Sort markers by time (required by lightweight-charts)
    markers.sort((a, b) => a.time - b.time);
    askSeries.setMarkers(markers);
  },
};

'use client';

import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useRef, useState } from 'react';
import type { Candle, CandleInterval, PerpCandleInterval } from '@flt/core/ports';

/**
 * Price chart.
 *
 * TradingView's Lightweight Charts, self-hosted, drawing candles we fetched
 * ourselves. Deliberately not TradingView's embed widget: that renders
 * centralised-exchange pairs, so it would sit next to our quote showing a
 * different price for the same token with no way for the user to tell which one
 * their trade will actually get. These candles come from the DEX pool we route
 * through, so the chart and the quote describe the same liquidity.
 *
 * The library paints to a canvas and cannot read CSS custom properties, so the
 * palette is read from the DOM on mount and re-read whenever the theme
 * attribute changes. Hard-coding two palettes here would let the chart drift
 * out of step with the design system the first time a token is retuned.
 */

interface PriceChartProps {
  candles: Candle[];
  /**
   * Only used to decide whether the time axis shows a clock, so it accepts the
   * perpetual intervals too rather than forcing the terminal to keep a second
   * chart component that differs in nothing else.
   */
  interval: CandleInterval | PerpCandleInterval;
  /** Decimal places for the price axis, derived from the price magnitude. */
  precision: number;
  height?: number;
}

interface Palette {
  text: string;
  subtle: string;
  border: string;
  positive: string;
  negative: string;
}

function readPalette(): Palette {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;

  return {
    text: token('--text', '#0e1116'),
    subtle: token('--text-subtle', '#8a93a3'),
    border: token('--border', '#e3e6ec'),
    positive: token('--positive', '#12783f'),
    negative: token('--negative', '#c02a37'),
  };
}

/** Alpha-blends a hex colour, for the volume histogram behind the candles. */
function fade(hex: string, alpha: number): string {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!match) return hex;
  const [r, g, b] = [match[1]!, match[2]!, match[3]!].map((part) => parseInt(part, 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function PriceChart({ candles, interval, precision, height = 380 }: PriceChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const priceSeries = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeries = useRef<ISeriesApi<'Histogram'> | null>(null);
  const [palette, setPalette] = useState<Palette | null>(null);

  // Re-read the palette whenever the theme attribute flips.
  useEffect(() => {
    setPalette(readPalette());

    const observer = new MutationObserver(() => setPalette(readPalette()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!container.current || !palette) return;

    const instance = createChart(container.current, {
      height,
      layout: {
        // Transparent so the card behind it supplies the surface colour and the
        // chart cannot disagree with its own container.
        background: { color: 'transparent' },
        textColor: palette.subtle,
        fontFamily: getComputedStyle(document.body).fontFamily,
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: fade(palette.border, 0.45) },
        horzLines: { color: fade(palette.border, 0.45) },
      },
      rightPriceScale: {
        borderColor: palette.border,
        // Room at the bottom for the volume histogram to sit under the price.
        scaleMargins: { top: 0.08, bottom: 0.26 },
      },
      timeScale: {
        borderColor: palette.border,
        // Intraday intervals need the clock; a daily series does not.
        timeVisible: interval !== '1d',
        secondsVisible: false,
      },
      crosshair: {
        vertLine: { color: palette.subtle, labelBackgroundColor: palette.text },
        horzLine: { color: palette.subtle, labelBackgroundColor: palette.text },
      },
      localization: {
        priceFormatter: (value: number) =>
          value.toLocaleString(undefined, {
            minimumFractionDigits: precision,
            maximumFractionDigits: precision,
          }),
      },
    });

    const price = instance.addSeries(CandlestickSeries, {
      upColor: palette.positive,
      downColor: palette.negative,
      borderUpColor: palette.positive,
      borderDownColor: palette.negative,
      wickUpColor: palette.positive,
      wickDownColor: palette.negative,
      priceFormat: { type: 'price', precision, minMove: 10 ** -precision },
    });

    const volume = instance.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      // Its own scale, so volume magnitude never distorts the price axis.
      priceScaleId: 'volume',
      lastValueVisible: false,
      priceLineVisible: false,
    });

    instance.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    chart.current = instance;
    priceSeries.current = price;
    volumeSeries.current = volume;

    // The container is width-driven by its parent; the chart is not, so it has
    // to be told when that width changes.
    //
    // Refitting after the resize is not optional. The library keeps its bar
    // spacing across a width change and anchors the newest bar to the right
    // edge, so a chart that was fitted while its container was still narrow —
    // which is the normal case inside a flex or grid panel that settles after
    // mount — ends up with every candle crushed against the right and dead
    // space on the left. It looks like missing data and is not.
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (!width) return;
      instance.applyOptions({ width });
      instance.timeScale().fitContent();
    });
    observer.observe(container.current);

    return () => {
      observer.disconnect();
      instance.remove();
      chart.current = null;
      priceSeries.current = null;
      volumeSeries.current = null;
    };
  }, [palette, height, interval, precision]);

  // Data updates are separate from construction, so switching interval does not
  // tear down and rebuild the chart.
  useEffect(() => {
    if (!priceSeries.current || !volumeSeries.current || !palette) return;

    const priceData: CandlestickData<Time>[] = candles.map((candle) => ({
      time: candle.time as UTCTimestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    }));

    const volumeData: HistogramData<Time>[] = candles.map((candle) => ({
      time: candle.time as UTCTimestamp,
      value: candle.volume,
      color: fade(candle.close >= candle.open ? palette.positive : palette.negative, 0.28),
    }));

    priceSeries.current.setData(priceData);
    volumeSeries.current.setData(volumeData);
    chart.current?.timeScale().fitContent();
  }, [candles, palette]);

  return (
    <div
      ref={container}
      className="w-full"
      style={{ height }}
      role="img"
      aria-label={`Price chart, ${interval} candles, ${candles.length} periods`}
    />
  );
}

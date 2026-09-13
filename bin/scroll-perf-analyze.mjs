#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access, chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';

const FRAME_QUERY = `
INCLUDE PERFETTO MODULE chrome.chrome_scrolls;
INCLUDE PERFETTO MODULE chrome.scroll_jank_v4;

WITH selected_frames AS (
  SELECT
    'scroll_jank_v4' AS source,
    presentation_ts,
    begin_frame_ts,
    is_janky
  FROM chrome_scroll_jank_v4_results
  WHERE presentation_ts IS NOT NULL
  UNION ALL
  SELECT
    'legacy_scroll_frame_info' AS source,
    presentation_ts,
    NULL AS begin_frame_ts,
    is_janky
  FROM chrome_scroll_frame_info
  WHERE presentation_ts IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM chrome_scroll_jank_v4_results LIMIT 1)
), frame_intervals AS (
  SELECT
    source,
    is_janky,
    (presentation_ts - LAG(presentation_ts) OVER (ORDER BY presentation_ts)) / 1000000.0 AS presentation_interval_ms,
    (presentation_ts - begin_frame_ts) / 1000000.0 AS begin_to_present_ms
  FROM selected_frames
)
SELECT source, is_janky, presentation_interval_ms, begin_to_present_ms
FROM frame_intervals
ORDER BY presentation_interval_ms;
`;

function renderingQuery(runName) {
  return `
WITH bounds AS (
  SELECT
    MIN(CASE WHEN name = '${runName}-start' THEN ts END) AS start_ts,
    MIN(CASE WHEN name = '${runName}-end' THEN ts END) AS end_ts
  FROM slice
), selected AS (
  SELECT
    CASE s.name
      WHEN 'AnimationFrame::Script::Execute' THEN 'animationScript'
      WHEN 'Blink.Style.UpdateTime' THEN 'style'
      WHEN 'Blink.Layout.UpdateTime' THEN 'layout'
      WHEN 'Blink.ForcedStyleAndLayout.UpdateTime' THEN 'forcedStyleLayout'
      WHEN 'Blink.PrePaint.UpdateTime' THEN 'prePaint'
      WHEN 'Blink.Paint.UpdateTime' THEN 'paint'
      WHEN 'RasterTask' THEN 'raster'
      WHEN 'Display::DrawAndSwap' THEN 'compositorDrawAndSwap'
    END AS stage,
    MIN(s.ts + s.dur, bounds.end_ts) - MAX(s.ts, bounds.start_ts) AS duration_ns
  FROM slice s
  CROSS JOIN bounds
  WHERE s.dur > 0
    AND s.ts < bounds.end_ts
    AND s.ts + s.dur > bounds.start_ts
)
SELECT stage, COUNT(*) AS count, SUM(duration_ns) / 1000000.0 AS total_ms
FROM selected
WHERE stage IS NOT NULL
GROUP BY stage
ORDER BY stage;
`;
}

function compositorQuery(runName) {
  return `
WITH bounds AS (
  SELECT
    MIN(CASE WHEN name = '${runName}-start' THEN ts END) AS start_ts,
    MIN(CASE WHEN name = '${runName}-end' THEN ts END) AS end_ts
  FROM slice
), selected AS (
  SELECT 'renderSurfaceCount' AS metric, EXTRACT_ARG(s.arg_set_id, 'args.render_surface_list_size()') AS value
  FROM slice s CROSS JOIN bounds
  WHERE s.name = 'LayerTreeHostImpl::CalculateRenderPasses' AND s.ts >= bounds.start_ts AND s.ts < bounds.end_ts
  UNION ALL
  SELECT 'renderPassQuads', EXTRACT_ARG(s.arg_set_id, 'args.NumberOfQuads')
  FROM slice s CROSS JOIN bounds
  WHERE s.name = 'DirectRenderer::DrawRenderPass' AND s.ts >= bounds.start_ts AND s.ts < bounds.end_ts
  UNION ALL
  SELECT
    CASE s.name
      WHEN 'LayerTreeImpl::UpdateDrawProperties' THEN 'updateDrawPropertiesMs'
      WHEN 'LayerTreeHostImpl::CalculateRenderPasses' THEN 'calculateRenderPassesMs'
      WHEN 'DirectRenderer::DrawFrame' THEN 'drawFrameMs'
      WHEN 'DirectRenderer::DrawRenderPass' THEN 'renderPassDrawMs'
      WHEN 'SkiaOutputSurfaceImplOnGpu::FinishPaintRenderPass' THEN 'gpuFinishPaintRenderPassMs'
      WHEN 'Graphics.Pipeline.DrawAndSwap' THEN 'graphicsDrawAndSwapMs'
    END,
    (MIN(s.ts + s.dur, bounds.end_ts) - MAX(s.ts, bounds.start_ts)) / 1000000.0
  FROM slice s CROSS JOIN bounds
  WHERE s.dur > 0
    AND s.ts < bounds.end_ts
    AND s.ts + s.dur > bounds.start_ts
    AND s.name IN (
      'LayerTreeImpl::UpdateDrawProperties',
      'LayerTreeHostImpl::CalculateRenderPasses',
      'DirectRenderer::DrawFrame',
      'DirectRenderer::DrawRenderPass',
      'SkiaOutputSurfaceImplOnGpu::FinishPaintRenderPass',
      'Graphics.Pipeline.DrawAndSwap'
    )
)
SELECT metric, value FROM selected WHERE value IS NOT NULL ORDER BY metric;
`;
}

const RENDERING_STAGES = [
  'animationScript',
  'style',
  'layout',
  'forcedStyleLayout',
  'prePaint',
  'paint',
  'raster',
  'compositorDrawAndSwap',
];

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(`Usage: pnpm scroll-perf:analyze <result-directory> [options]

Options:
  --trace-processor <path>  Use an existing Perfetto trace_processor executable
  --help                    Show this message

Without --trace-processor, the official Perfetto wrapper is cached under
~/.cache/scroll-perf and downloads its pinned native binary on first use.`);
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help') usage();
    if (argument === '--trace-processor') options.traceProcessor = argv[++index];
    else if (!argument.startsWith('-') && !options.directory) options.directory = resolve(argument);
    else if (argument !== '--trace-processor') usage(`unknown argument ${argument}`);
  }
  if (!options.directory) usage('result directory is required');
  return options;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function traceProcessorPath(explicitPath) {
  if (explicitPath) return resolve(explicitPath);
  if (process.env.TRACE_PROCESSOR) return resolve(process.env.TRACE_PROCESSOR);

  const cacheDirectory = join(homedir(), '.cache', 'scroll-perf');
  const wrapper = join(cacheDirectory, 'trace_processor');
  if (!(await exists(wrapper))) {
    console.error(`Downloading the official Perfetto trace processor wrapper to ${wrapper}`);
    const response = await fetch('https://get.perfetto.dev/trace_processor');
    if (!response.ok) throw new Error(`Perfetto download failed: HTTP ${response.status}`);
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(wrapper, new Uint8Array(await response.arrayBuffer()));
    await chmod(wrapper, 0o755);
  }
  return wrapper;
}

function run(command, arguments_) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${basename(command)} exited with ${code}\n${stderr}`));
    });
  });
}

function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') field += line[index++];
    else if (character === '"') quoted = !quoted;
    else if (character === ',' && !quoted) (fields.push(field), (field = ''));
    else field += character;
  }
  fields.push(field);
  return fields;
}

function parseCsv(csv) {
  const lines = csv.trim().split('\n').filter(Boolean);
  const headers = parseCsvLine(lines.shift() ?? '');
  return lines.map(line =>
    Object.fromEntries(parseCsvLine(line).map((value, index) => [headers[index], value])),
  );
}

function quantile(values, percentile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower] + ((sorted[lower + 1] ?? sorted[lower]) - sorted[lower]) * fraction;
}

function statistics(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return null;
  return {
    mean: finite.reduce((sum, value) => sum + value, 0) / finite.length,
    median: quantile(finite, 0.5),
    p95: quantile(finite, 0.95),
    max: Math.max(...finite),
  };
}

function summarizeFrames(rows) {
  const numbers = key => rows.map(row => Number(row[key])).filter(Number.isFinite);
  const classified = rows.filter(row => row.is_janky === '0' || row.is_janky === '1');
  const jankyFrames = classified.filter(row => row.is_janky === '1').length;
  const presentationIntervals = numbers('presentation_interval_ms');
  const estimatedRefreshIntervalMs = quantile(presentationIntervals, 0.1);
  const longFrameThresholdMs = estimatedRefreshIntervalMs === null ? null : estimatedRefreshIntervalMs * 1.5;
  const longFrames =
    longFrameThresholdMs === null
      ? []
      : presentationIntervals.filter(interval => interval >= longFrameThresholdMs);
  return {
    source: rows[0]?.source ?? null,
    frames: rows.length,
    jank: {
      classifiedFrames: classified.length,
      jankyFrames,
      percent: classified.length ? (jankyFrames / classified.length) * 100 : null,
    },
    cadenceEstimate: {
      estimatedRefreshIntervalMs,
      longFrameThresholdMs,
      longFrames: longFrames.length,
      longFramePercent: presentationIntervals.length
        ? (longFrames.length / presentationIntervals.length) * 100
        : null,
      estimatedMissedRefreshes:
        estimatedRefreshIntervalMs === null
          ? null
          : presentationIntervals.reduce(
              (total, interval) => total + Math.max(0, Math.round(interval / estimatedRefreshIntervalMs) - 1),
              0,
            ),
    },
    presentationIntervalMs: statistics(presentationIntervals),
    beginToPresentMs: statistics(numbers('begin_to_present_ms')),
  };
}

function summarizeDrm(sidecar) {
  const phases = {
    idle: sidecar.drmSamples.filter(sample => sample.elapsedMs < sidecar.scroll.startMs),
    scroll: sidecar.drmSamples.filter(
      sample => sample.elapsedMs >= sidecar.scroll.startMs && sample.elapsedMs <= sidecar.scroll.endMs,
    ),
  };
  const devices = new Set(sidecar.drmSamples.flatMap(sample => Object.keys(sample.devices)));
  const units = {
    busyPercent: 1,
    memoryBusyPercent: 1,
    vramUsedMiB: 1 / 1048576,
    powerWatts: 1 / 1000000,
    gpuClockMHz: 1 / 1000000,
    memoryClockMHz: 1 / 1000000,
    temperatureCelsius: 1 / 1000,
  };
  const sourceKeys = {
    busyPercent: 'busyPercent',
    memoryBusyPercent: 'memoryBusyPercent',
    vramUsedMiB: 'vramUsedBytes',
    powerWatts: 'powerMicrowatts',
    gpuClockMHz: 'gpuClockHz',
    memoryClockMHz: 'memoryClockHz',
    temperatureCelsius: 'temperatureMillidegrees',
  };

  return Object.fromEntries(
    [...devices].map(device => [
      device,
      Object.fromEntries(
        Object.entries(phases).map(([phase, samples]) => [
          phase,
          Object.fromEntries(
            Object.entries(sourceKeys).flatMap(([name, sourceKey]) => {
              const values = samples
                .map(sample => sample.devices[device]?.[sourceKey] * units[name])
                .filter(Number.isFinite);
              const summary = statistics(values);
              return summary ? [[name, summary]] : [];
            }),
          ),
        ]),
      ),
    ]),
  );
}

function summarizeProcesses(sidecar) {
  const before = new Map(sidecar.processesBefore.processInfo.map(info => [info.id, info]));
  const durationSeconds = (sidecar.scroll.endMs - sidecar.scroll.startMs) / 1000;
  const byType = new Map();
  for (const after of sidecar.processesAfter.processInfo) {
    const cpuSeconds = after.cpuTime - (before.get(after.id)?.cpuTime ?? after.cpuTime);
    byType.set(after.type, (byType.get(after.type) ?? 0) + cpuSeconds);
  }
  const processes = Object.fromEntries(
    [...byType].map(([type, cpuSeconds]) => [
      type,
      {
        cpuSeconds,
        averageOneCorePercent: durationSeconds ? (cpuSeconds / durationSeconds) * 100 : null,
      },
    ]),
  );
  const totalCpuSeconds = [...byType.values()].reduce((sum, cpuSeconds) => sum + cpuSeconds, 0);
  processes.totalChrome = {
    cpuSeconds: totalCpuSeconds,
    averageOneCorePercent: durationSeconds ? (totalCpuSeconds / durationSeconds) * 100 : null,
  };
  return processes;
}

function summarizeRendering(rows, durationMs, presentedFrames) {
  const byStage = new Map(rows.map(row => [row.stage, row]));
  return {
    windowDurationMs: durationMs,
    stages: Object.fromEntries(
      RENDERING_STAGES.map(stage => {
        const row = byStage.get(stage);
        const totalMs = Number(row?.total_ms ?? 0);
        return [
          stage,
          {
            count: Number(row?.count ?? 0),
            totalMs,
            averageOneCorePercent: durationMs ? (totalMs / durationMs) * 100 : null,
            msPerPresentedFrame: presentedFrames ? totalMs / presentedFrames : null,
          },
        ];
      }),
    ),
  };
}

function summarizeCompositor(rows, presentedFrames) {
  const byMetric = new Map();
  for (const row of rows) {
    const value = Number(row.value);
    if (!Number.isFinite(value)) continue;
    if (!byMetric.has(row.metric)) byMetric.set(row.metric, []);
    byMetric.get(row.metric).push(value);
  }
  const eventMetrics = Object.fromEntries(
    [...byMetric].map(([metric, values]) => [
      metric,
      {
        ...statistics(values),
        count: values.length,
        total: values.reduce((sum, value) => sum + value, 0),
        perPresentedFrame: presentedFrames
          ? values.reduce((sum, value) => sum + value, 0) / presentedFrames
          : null,
      },
    ]),
  );
  return {
    events: eventMetrics,
    renderPassDrawEventsPerPresentedFrame: presentedFrames
      ? (byMetric.get('renderPassDrawMs')?.length ?? 0) / presentedFrames
      : null,
    quadsPerPresentedFrame: presentedFrames
      ? (byMetric.get('renderPassQuads') ?? []).reduce((sum, value) => sum + value, 0) / presentedFrames
      : null,
  };
}

function flattenNumbers(value, prefix = '', output = {}) {
  for (const [key, child] of Object.entries(value ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'number' && Number.isFinite(child)) output[path] = child;
    else if (child && typeof child === 'object') flattenNumbers(child, path, output);
  }
  return output;
}

function aggregateRuns(runs) {
  const values = new Map();
  for (const run of runs) {
    for (const [path, value] of Object.entries(flattenNumbers(run))) {
      if (path.startsWith('runNumber') || path.startsWith('scroll.')) continue;
      if (!values.has(path)) values.set(path, []);
      values.get(path).push(value);
    }
  }
  return Object.fromEntries([...values].map(([path, samples]) => [path, statistics(samples)]));
}

async function analyzeRun(directory, file, traceProcessor) {
  const sidecar = JSON.parse(await readFile(join(directory, file), 'utf8'));
  const trace = join(directory, file.replace(/\.json$/, '.trace.json'));
  if (!(await exists(trace))) throw new Error(`Missing trace for ${file}`);
  const frameRows = parseCsv(await run(traceProcessor, ['query', trace, FRAME_QUERY]));
  const runName = file.replace(/\.json$/, '');
  const renderingRows = parseCsv(await run(traceProcessor, ['query', trace, renderingQuery(runName)]));
  const compositorRows = parseCsv(await run(traceProcessor, ['query', trace, compositorQuery(runName)]));
  const durationMs = sidecar.scroll.endMs - sidecar.scroll.startMs;
  return {
    runNumber: sidecar.runNumber,
    scroll: sidecar.scroll,
    frames: summarizeFrames(frameRows),
    rendering: summarizeRendering(renderingRows, durationMs, frameRows.length),
    compositor: summarizeCompositor(compositorRows, frameRows.length),
    processes: summarizeProcesses(sidecar),
    drm: summarizeDrm(sidecar),
    pageComplexity: sidecar.pageComplexity ?? null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(join(options.directory, 'manifest.json'), 'utf8'));
  const files = (await readdir(options.directory)).filter(file => /^run-\d+\.json$/.test(file)).sort();
  if (!files.length) throw new Error(`No run sidecars found in ${options.directory}`);
  const traceProcessor = await traceProcessorPath(options.traceProcessor);
  const runs = [];
  for (const [index, file] of files.entries()) {
    process.stderr.write(`Analyzing ${index + 1}/${files.length}: ${file}\r`);
    runs.push(await analyzeRun(options.directory, file, traceProcessor));
  }
  process.stderr.write(' '.repeat(70) + '\r');

  const summary = { manifest, runs, aggregate: aggregateRuns(runs) };
  const output = join(options.directory, 'summary.json');
  await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Analyzed ${runs.length} run(s): ${output}`);
  console.log(`Renderer: ${manifest.systemInfo.gpu.auxAttributes?.glRenderer ?? 'unknown'}`);
  console.log(
    `Median presentation interval: ${summary.aggregate['frames.presentationIntervalMs.median']?.median?.toFixed(3) ?? 'n/a'} ms`,
  );
  const jank = summary.aggregate['frames.jank.percent']?.median;
  console.log(`Median jank: ${jank === undefined ? 'not classified' : `${jank.toFixed(3)}%`}`);
}

await main();

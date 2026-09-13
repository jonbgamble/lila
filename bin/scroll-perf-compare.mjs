#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(`Usage: pnpm scroll-perf:compare <baseline-directory> <candidate-directory> [--force]

Both directories must contain summary.json from scroll-perf:analyze.
Use --force to compare incompatible environments while retaining warnings.`);
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const force = argv.includes('--force');
  const directories = argv.filter(argument => !argument.startsWith('-')).map(directory => resolve(directory));
  if (argv.includes('--help')) usage();
  if (directories.length !== 2) usage('baseline and candidate directories are required');
  return { baselineDirectory: directories[0], candidateDirectory: directories[1], force };
}

function get(value, path) {
  return path.split('.').reduce((current, key) => current?.[key], value);
}

function quantile(values, percentile) {
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower] + ((sorted[lower + 1] ?? sorted[lower]) - sorted[lower]) * fraction;
}

function median(values) {
  return quantile(values, 0.5);
}

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrapMedianDifference(baseline, candidate, iterations = 10000) {
  const random = randomGenerator(0x5c4011);
  const differences = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const baselineSample = Array.from(
      { length: baseline.length },
      () => baseline[Math.floor(random() * baseline.length)],
    );
    const candidateSample = Array.from(
      { length: candidate.length },
      () => candidate[Math.floor(random() * candidate.length)],
    );
    differences.push(median(candidateSample) - median(baselineSample));
  }
  return { low: quantile(differences, 0.025), high: quantile(differences, 0.975) };
}

function environment(summary) {
  const { manifest } = summary;
  return {
    browserVersion: manifest.browserVersion,
    viewport: manifest.options.viewport,
    channel: manifest.options.channel,
    speed: manifest.options.speed,
    durationSeconds: manifest.options.durationSeconds,
    theme: manifest.options.theme ?? null,
    backgroundImage: manifest.options.backgroundImage ?? null,
    renderer: manifest.systemInfo.gpu.auxAttributes?.glRenderer,
    gpuCompositing: manifest.systemInfo.gpu.featureStatus?.gpu_compositing,
    rasterization: manifest.systemInfo.gpu.featureStatus?.rasterization,
    drmDevices: manifest.drmDevices.map(device => ({ vendorId: device.vendorId, deviceId: device.deviceId })),
    scrollDistances: summary.runs.map(run => run.scroll.distance),
  };
}

function environmentDifferences(baseline, candidate) {
  const left = environment(baseline);
  const right = environment(candidate);
  return Object.keys(left).flatMap(key =>
    JSON.stringify(left[key]) === JSON.stringify(right[key])
      ? []
      : [{ key, baseline: left[key], candidate: right[key] }],
  );
}

function metricPaths(summary) {
  const paths = [
    'pageComplexity.cssEffectsBefore.backdropFilter.count',
    'pageComplexity.cssEffectsBefore.backdropFilter.pseudoElementCount',
    'pageComplexity.cssEffectsBefore.backdropFilter.visibleCount',
    'pageComplexity.cssEffectsBefore.backdropFilter.viewportAreaCssPixels',
    'pageComplexity.cssEffectsBefore.filter.count',
    'pageComplexity.cssEffectsBefore.filter.pseudoElementCount',
    'pageComplexity.cssEffectsBefore.filter.visibleCount',
    'pageComplexity.cssEffectsBefore.filter.viewportAreaCssPixels',
    'compositor.events.renderSurfaceCount.median',
    'compositor.events.renderSurfaceCount.max',
    'compositor.renderPassDrawEventsPerPresentedFrame',
    'compositor.quadsPerPresentedFrame',
    'compositor.events.updateDrawPropertiesMs.perPresentedFrame',
    'compositor.events.calculateRenderPassesMs.perPresentedFrame',
    'compositor.events.drawFrameMs.perPresentedFrame',
    'compositor.events.renderPassDrawMs.perPresentedFrame',
    'compositor.events.gpuFinishPaintRenderPassMs.perPresentedFrame',
    'compositor.events.graphicsDrawAndSwapMs.perPresentedFrame',
    'processes.totalChrome.averageOneCorePercent',
    'processes.browser.averageOneCorePercent',
    'processes.renderer.averageOneCorePercent',
    'processes.GPU.averageOneCorePercent',
    'frames.presentationIntervalMs.median',
    'frames.presentationIntervalMs.p95',
    'frames.presentationIntervalMs.max',
    'frames.beginToPresentMs.median',
    'frames.beginToPresentMs.p95',
    'frames.jank.percent',
    'frames.cadenceEstimate.longFramePercent',
    'frames.cadenceEstimate.estimatedMissedRefreshes',
  ];
  for (const stage of Object.keys(summary.runs[0]?.rendering?.stages ?? {})) {
    paths.push(
      `rendering.stages.${stage}.averageOneCorePercent`,
      `rendering.stages.${stage}.msPerPresentedFrame`,
    );
  }
  const selectedGpu = summary.manifest.options.gpu;
  const devices =
    selectedGpu && summary.runs[0]?.drm?.[selectedGpu]
      ? [selectedGpu]
      : Object.keys(summary.runs[0]?.drm ?? {});
  for (const device of devices) {
    for (const metric of ['busyPercent.mean', 'powerWatts.mean', 'gpuClockMHz.mean', 'vramUsedMiB.mean']) {
      paths.push(`drm.${device}.idle.${metric}`, `drm.${device}.scroll.${metric}`);
    }
  }
  return paths;
}

function compareMetric(path, baseline, candidate) {
  const baselineValues = baseline.runs.map(run => get(run, path)).filter(Number.isFinite);
  const candidateValues = candidate.runs.map(run => get(run, path)).filter(Number.isFinite);
  if (!baselineValues.length || !candidateValues.length) return null;
  const baselineMedian = median(baselineValues);
  const candidateMedian = median(candidateValues);
  const difference = candidateMedian - baselineMedian;
  return {
    path,
    baselineMedian,
    candidateMedian,
    difference,
    percentChange: baselineMedian === 0 ? null : (difference / baselineMedian) * 100,
    differenceConfidence95: bootstrapMedianDifference(baselineValues, candidateValues),
    baselineRuns: baselineValues.length,
    candidateRuns: candidateValues.length,
  };
}

function formatNumber(value) {
  return value === null ? 'n/a' : Number(value).toFixed(3);
}

function markdownCell(value) {
  return value.replaceAll('|', '\\|');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const baseline = JSON.parse(await readFile(join(options.baselineDirectory, 'summary.json'), 'utf8'));
  const candidate = JSON.parse(await readFile(join(options.candidateDirectory, 'summary.json'), 'utf8'));
  const warnings = environmentDifferences(baseline, candidate);
  if (warnings.length && !options.force) {
    const details = warnings
      .map(
        warning =>
          `  ${warning.key}: ${JSON.stringify(warning.baseline)} != ${JSON.stringify(warning.candidate)}`,
      )
      .join('\n');
    throw new Error(`Benchmark environments differ:\n${details}\nPass --force only if this is intentional.`);
  }

  const sharedPaths = metricPaths(baseline).filter(path => metricPaths(candidate).includes(path));
  const metrics = sharedPaths.map(path => compareMetric(path, baseline, candidate)).filter(Boolean);
  const comparison = {
    createdAt: new Date().toISOString(),
    baselineDirectory: options.baselineDirectory,
    candidateDirectory: options.candidateDirectory,
    warnings,
    metrics,
  };
  const output = join(options.candidateDirectory, 'comparison.json');
  await writeFile(output, `${JSON.stringify(comparison, null, 2)}\n`);

  const baselineName = markdownCell(basename(options.baselineDirectory));
  const candidateName = markdownCell(basename(options.candidateDirectory));
  console.log(`| Metric | ${baselineName} median | ${candidateName} median | Change | 95% CI (absolute) |`);
  console.log('| --- | ---: | ---: | ---: | ---: |');
  for (const metric of metrics) {
    const confidence = `${formatNumber(metric.differenceConfidence95.low)} to ${formatNumber(metric.differenceConfidence95.high)}`;
    const change = metric.percentChange === null ? 'n/a' : `${formatNumber(metric.percentChange)}%`;
    console.log(
      `| ${metric.path} | ${formatNumber(metric.baselineMedian)} | ${formatNumber(metric.candidateMedian)} | ${change} | ${confidence} |`,
    );
  }
  if (warnings.length)
    console.error(`Compared with ${warnings.length} environment warning(s) because --force was used.`);
  console.error(`Full comparison: ${output}`);
}

await main();

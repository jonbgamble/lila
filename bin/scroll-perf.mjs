#!/usr/bin/env node

import { chromium } from '@playwright/test';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import process from 'node:process';

const TRACE_CATEGORIES = [
  'benchmark',
  'blink',
  'blink.user_timing',
  'cc',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-devtools.timeline.inputs',
  'disabled-by-default-display.framedisplayed',
  'gpu',
  'input',
  'input.scrolling',
  'latency',
  'latencyInfo',
  'toplevel',
  'viz',
];

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(`Usage: pnpm scroll-perf --url <url> [options]

Options:
  --url <url>             Page to measure (required)
  --viewport <width>x<height>  Viewport in CSS pixels (default: 1440x900)
  --runs <count>          Measured runs (default: 10)
  --warmups <count>       Unmeasured runs (default: 2)
  --duration <seconds>    Target scroll duration (default: 5)
  --speed <pixels/sec>    Scroll speed (default: 1200)
  --output <directory>    Artifact directory (default: ../scroll-perf-results/<timestamp>)
  --channel <name>        Playwright browser channel (default: chrome)
  --gpu <cardN>           Use a specific Linux DRM GPU (for example: card0)
  --theme <name>          Force light, dark, or transp theme before page scripts
  --background-image <url>  Background image used with the transp theme
  --list-gpus             List discovered Linux DRM GPUs and exit
  --allow-software        Permit software rendering instead of failing
  --help                  Show this message`);
  process.exit(message ? 1 : 0);
}

function positiveNumber(value, option) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) usage(`${option} must be a positive number`);
  return parsed;
}

function nonNegativeInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) usage(`${option} must be a non-negative integer`);
  return parsed;
}

function parseArgs(argv) {
  const options = {
    viewport: { width: 1440, height: 900 },
    runs: 10,
    warmups: 2,
    durationSeconds: 5,
    speed: 1200,
    channel: 'chrome',
    allowSoftware: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === '--help') usage();
    else if (option === '--allow-software') options.allowSoftware = true;
    else if (option === '--list-gpus') options.listGpus = true;
    else if (option === '--url') ((options.url = value), index++);
    else if (option === '--viewport') {
      const match = /^(\d+)x(\d+)$/.exec(value ?? '');
      if (!match) usage('--viewport must look like 1440x900');
      options.viewport = {
        width: positiveNumber(match[1], '--viewport'),
        height: positiveNumber(match[2], '--viewport'),
      };
      index++;
    } else if (option === '--runs') ((options.runs = positiveNumber(value, option)), index++);
    else if (option === '--warmups') ((options.warmups = nonNegativeInteger(value, option)), index++);
    else if (option === '--duration') ((options.durationSeconds = positiveNumber(value, option)), index++);
    else if (option === '--speed') ((options.speed = positiveNumber(value, option)), index++);
    else if (option === '--output') ((options.output = value), index++);
    else if (option === '--channel') ((options.channel = value), index++);
    else if (option === '--gpu') ((options.gpu = value), index++);
    else if (option === '--theme') ((options.theme = value), index++);
    else if (option === '--background-image') ((options.backgroundImage = value), index++);
    else usage(`unknown option ${option}`);
  }

  if (!options.listGpus) {
    if (!options.url) usage('--url is required');
    try {
      options.url = new URL(options.url).href;
    } catch {
      usage('--url must be an absolute URL');
    }
  }
  if (options.theme && !['light', 'dark', 'transp'].includes(options.theme)) {
    usage('--theme must be light, dark, or transp');
  }
  if (options.backgroundImage && options.theme !== 'transp') {
    usage('--background-image requires --theme transp');
  }
  options.runs = Math.floor(options.runs);
  options.output ??= join('..', 'scroll-perf-results', new Date().toISOString().replaceAll(':', '-'));
  return options;
}

function contextOptions(options) {
  return {
    viewport: options.viewport,
    deviceScaleFactor: 1,
  };
}

async function forceVisualState(context, options) {
  if (!options.theme) return;
  await context.addInitScript(theme => {
    const apply = () => {
      document.documentElement.classList.remove('light', 'dark', 'transp');
      document.documentElement.classList.add(theme);
      if (document.body) document.body.dataset.theme = theme;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { childList: true });
    window.addEventListener(
      'DOMContentLoaded',
      () => {
        apply();
        observer.disconnect();
      },
      { once: true },
    );
    window.addEventListener('load', apply, { once: true });
  }, options.theme);
}

async function readableNumber(path) {
  try {
    return Number((await readFile(path, 'utf8')).trim());
  } catch {
    return undefined;
  }
}

async function discoverDrmDevices() {
  let names = [];
  try {
    names = await readdir('/sys/class/drm');
  } catch {
    return [];
  }

  return Promise.all(
    names
      .filter(name => /^card\d+$/.test(name))
      .map(async name => {
        const root = `/sys/class/drm/${name}/device`;
        const hwmonRoot = `${root}/hwmon`;
        const hwmon = await readdir(hwmonRoot).catch(() => []);
        const drm = await readdir(`${root}/drm`).catch(() => []);
        const sensorRoot = hwmon[0] ? `${hwmonRoot}/${hwmon[0]}` : undefined;
        const renderNode = drm.find(entry => /^renderD\d+$/.test(entry));
        return {
          name,
          root,
          renderNode: renderNode ? `/dev/dri/${renderNode}` : undefined,
          vendorId: await readableNumber(`${root}/vendor`),
          deviceId: await readableNumber(`${root}/device`),
          sensorRoot,
        };
      }),
  );
}

async function sampleDrmDevice(device) {
  const sample = {
    busyPercent: await readableNumber(`${device.root}/gpu_busy_percent`),
    memoryBusyPercent: await readableNumber(`${device.root}/mem_busy_percent`),
    vramUsedBytes: await readableNumber(`${device.root}/mem_info_vram_used`),
    vramTotalBytes: await readableNumber(`${device.root}/mem_info_vram_total`),
  };
  if (device.sensorRoot) {
    sample.powerMicrowatts = await readableNumber(`${device.sensorRoot}/power1_average`);
    sample.gpuClockHz = await readableNumber(`${device.sensorRoot}/freq1_input`);
    sample.memoryClockHz = await readableNumber(`${device.sensorRoot}/freq2_input`);
    sample.temperatureMillidegrees = await readableNumber(`${device.sensorRoot}/temp1_input`);
  }
  return Object.fromEntries(Object.entries(sample).filter(([, value]) => value !== undefined));
}

async function readTraceStream(cdp, stream) {
  let trace = '';
  while (true) {
    const chunk = await cdp.send('IO.read', { handle: stream });
    trace += chunk.data;
    if (chunk.eof) break;
  }
  await cdp.send('IO.close', { handle: stream });
  return trace;
}

function renderingIsHardwareAccelerated(gpu) {
  const status = gpu.featureStatus ?? {};
  const renderer = String(gpu.auxAttributes?.glRenderer ?? '');
  return (
    status.gpu_compositing === 'enabled' &&
    status.rasterization === 'enabled' &&
    !/swiftshader/i.test(renderer)
  );
}

async function applyVisualState(page, options) {
  if (!options.theme) return;
  await page.evaluate(
    async ({ theme, backgroundImage }) => {
      if (backgroundImage) {
        await new Promise(resolve => {
          const image = new Image();
          image.addEventListener('load', resolve, { once: true });
          image.addEventListener('error', resolve, { once: true });
          image.src = backgroundImage;
        });
      }
      document.documentElement.classList.remove('light', 'dark', 'transp');
      document.documentElement.classList.add(theme);
      document.body.dataset.theme = theme;
      if (backgroundImage) {
        document.querySelectorAll('#bg-data').forEach(element => element.remove());
        const bgData = document.createElement('style');
        bgData.id = 'bg-data';
        bgData.textContent = 'html.transp::before {}';
        document.head.append(bgData);
        bgData.sheet.cssRules[0].style.backgroundImage = `url(${JSON.stringify(backgroundImage)})`;
      }
    },
    { theme: options.theme, backgroundImage: options.backgroundImage },
  );
}

async function preparePage(page, options) {
  await page.goto(options.url, { waitUntil: 'load' });
  await applyVisualState(page, options);
  await page.evaluate(async () => {
    await document.fonts?.ready;
    await Promise.all(
      [...document.images]
        .filter(image => !image.complete)
        .map(image => new Promise(resolve => image.addEventListener('load', resolve, { once: true }))),
    );
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(500);
}

async function inspectCssEffects(page) {
  return page.evaluate(() => {
    const elements = [];
    const visit = root => {
      for (const element of root.querySelectorAll('*')) {
        elements.push(element);
        if (element.shadowRoot) visit(element.shadowRoot);
      }
    };
    visit(document);

    const effects = { backdropFilter: [], filter: [] };
    const inspect = (style, rect, pseudo) => {
      const visible =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) !== 0 &&
        rect.width > 0 &&
        rect.height > 0;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const visibleWidth = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
      const visibleHeight = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
      const viewportAreaCssPixels = visible ? visibleWidth * visibleHeight : 0;
      const backdropFilter = style.backdropFilter || style.webkitBackdropFilter;
      if (backdropFilter && backdropFilter !== 'none')
        effects.backdropFilter.push({ value: backdropFilter, viewportAreaCssPixels, pseudo });
      if (style.filter && style.filter !== 'none')
        effects.filter.push({ value: style.filter, viewportAreaCssPixels, pseudo });
    };
    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      inspect(window.getComputedStyle(element), rect, false);
      for (const pseudo of ['::before', '::after']) {
        const style = window.getComputedStyle(element, pseudo);
        if (style.content !== 'none') inspect(style, rect, true);
      }
    }

    return Object.fromEntries(
      Object.entries(effects).map(([name, matches]) => [
        name,
        {
          count: matches.length,
          pseudoElementCount: matches.filter(match => match.pseudo).length,
          visibleCount: matches.filter(match => match.viewportAreaCssPixels > 0).length,
          viewportAreaCssPixels: matches.reduce((total, match) => total + match.viewportAreaCssPixels, 0),
          values: Object.fromEntries(
            matches
              .map(match => match.value)
              .sort()
              .map(value => [value, matches.filter(match => match.value === value).length]),
          ),
        },
      ]),
    );
  });
}

async function scroll(page, pageCdp, options, marker) {
  const dimensions = await page.evaluate(() => ({
    viewportHeight: window.innerHeight,
    documentHeight: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
    startY: window.scrollY,
  }));
  const availableDistance = Math.max(
    0,
    dimensions.documentHeight - dimensions.viewportHeight - dimensions.startY,
  );
  const distance = Math.min(availableDistance, options.speed * options.durationSeconds);
  if (distance < 1) throw new Error('The document is not vertically scrollable');

  await pageCdp.send('Input.synthesizeScrollGesture', {
    x: Math.floor(options.viewport.width / 2),
    y: Math.floor(options.viewport.height / 2),
    yDistance: -distance,
    speed: options.speed,
    gestureSourceType: 'mouse',
    interactionMarkerName: marker,
  });
  return { ...dimensions, distance, endY: await page.evaluate(() => window.scrollY) };
}

async function captureRun(browser, drmDevices, options, runNumber) {
  const context = await browser.newContext(contextOptions(options));
  await forceVisualState(context, options);
  const page = await context.newPage();
  const browserCdp = await browser.newBrowserCDPSession();
  const pageCdp = await context.newCDPSession(page);
  const runName = `run-${String(runNumber).padStart(3, '0')}`;

  try {
    await preparePage(page, options);
    const gpuInfo = await browserCdp.send('SystemInfo.getInfo');
    if (!options.allowSoftware && !renderingIsHardwareAccelerated(gpuInfo.gpu)) {
      throw new Error(
        `Chrome is not hardware accelerated (${gpuInfo.gpu.auxAttributes?.glRenderer ?? 'unknown renderer'})`,
      );
    }

    const complete = new Promise(resolve => browserCdp.once('Tracing.tracingComplete', resolve));
    await browserCdp.send('Tracing.start', {
      transferMode: 'ReturnAsStream',
      streamFormat: 'json',
      traceConfig: {
        recordMode: 'recordContinuously',
        traceBufferSizeInKb: 131072,
        includedCategories: TRACE_CATEGORIES,
      },
    });

    const samples = [];
    const pendingSamples = new Set();
    const sampleStart = performance.now();
    const sampler = setInterval(() => {
      const pending = Promise.all(
        drmDevices.map(async device => [device.name, await sampleDrmDevice(device)]),
      )
        .then(devices =>
          samples.push({ elapsedMs: performance.now() - sampleStart, devices: Object.fromEntries(devices) }),
        )
        .finally(() => pendingSamples.delete(pending));
      pendingSamples.add(pending);
    }, 50);

    await page.waitForTimeout(750);
    const visualState = await page.evaluate(() => ({
      htmlClass: document.documentElement.className,
      bodyTheme: document.body.dataset.theme ?? null,
      backgroundImage: window.getComputedStyle(document.documentElement, '::before').backgroundImage,
    }));
    const cssEffectsBefore = await inspectCssEffects(page);
    const processesBefore = await browserCdp.send('SystemInfo.getProcessInfo');
    await page.evaluate(marker => performance.mark(marker), `${runName}-start`);
    const scrollStartMs = performance.now() - sampleStart;
    const scrollResult = await scroll(page, pageCdp, options, runName);
    const scrollEndMs = performance.now() - sampleStart;
    await page.evaluate(marker => performance.mark(marker), `${runName}-end`);
    const processesAfter = await browserCdp.send('SystemInfo.getProcessInfo');
    const cssEffectsAfter = await inspectCssEffects(page);
    await page.waitForTimeout(750);

    clearInterval(sampler);
    await Promise.all(pendingSamples);
    await browserCdp.send('Tracing.end');
    const result = await complete;
    const trace = await readTraceStream(browserCdp, result.stream);
    const sidecar = {
      runNumber,
      scroll: { ...scrollResult, startMs: scrollStartMs, endMs: scrollEndMs },
      drmSamples: samples,
      processesBefore,
      processesAfter,
      pageComplexity: {
        visualState,
        cssEffectsBefore,
        cssEffectsAfter,
      },
    };
    await Promise.all([
      writeFile(join(options.output, `${runName}.trace.json`), trace),
      writeFile(join(options.output, `${runName}.json`), `${JSON.stringify(sidecar, null, 2)}\n`),
    ]);
    return sidecar;
  } finally {
    await context.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const drmDevices = await discoverDrmDevices();
  if (options.listGpus) {
    console.table(
      drmDevices.map(({ name, renderNode, vendorId, deviceId }) => ({
        name,
        renderNode,
        vendorId,
        deviceId,
      })),
    );
    return;
  }
  const selectedGpu = options.gpu ? drmDevices.find(device => device.name === options.gpu) : undefined;
  if (options.gpu && !selectedGpu) {
    throw new Error(
      `Unknown GPU ${options.gpu}; available DRM cards: ${drmDevices.map(device => device.name).join(', ') || 'none'}`,
    );
  }
  if (selectedGpu && !selectedGpu.renderNode) throw new Error(`No render node found for ${selectedGpu.name}`);
  await mkdir(options.output, { recursive: true });
  const browser = await chromium.launch({
    channel: options.channel,
    headless: false,
    args: selectedGpu ? [`--render-node-override=${selectedGpu.renderNode}`] : [],
  });

  try {
    const browserVersion = browser.version();
    const browserCdp = await browser.newBrowserCDPSession();
    const systemInfo = await browserCdp.send('SystemInfo.getInfo');
    if (!options.allowSoftware && !renderingIsHardwareAccelerated(systemInfo.gpu)) {
      throw new Error(
        `Chrome is not hardware accelerated (${systemInfo.gpu.auxAttributes?.glRenderer ?? 'unknown renderer'})`,
      );
    }
    await writeFile(
      join(options.output, 'manifest.json'),
      `${JSON.stringify({ createdAt: new Date().toISOString(), options, browserVersion, platform: process.platform, release: process.release, drmDevices, systemInfo }, null, 2)}\n`,
    );
    console.log(`Chrome ${browserVersion}; output: ${options.output}`);

    for (let warmup = 1; warmup <= options.warmups; warmup++) {
      process.stdout.write(`Warm-up ${warmup}/${options.warmups}... `);
      const context = await browser.newContext(contextOptions(options));
      try {
        await forceVisualState(context, options);
        const page = await context.newPage();
        await preparePage(page, options);
        await scroll(page, await context.newCDPSession(page), options, `warmup-${warmup}`);
        console.log('done');
      } finally {
        await context.close();
      }
    }

    for (let run = 1; run <= options.runs; run++) {
      process.stdout.write(`Run ${run}/${options.runs}... `);
      const result = await captureRun(browser, drmDevices, options, run);
      console.log(`${result.scroll.distance}px in ${basename(options.output)}`);
    }
  } finally {
    await browser.close();
  }
}

await main();

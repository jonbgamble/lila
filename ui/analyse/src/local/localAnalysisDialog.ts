import type { ChartGame, AcplChart } from 'chart';

import { myUserId } from 'lib';
import { isEquivalent } from 'lib/algo';
import type { CustomCeval } from 'lib/ceval/types';
import { numberFormat } from 'lib/i18n';
import { licon } from 'lib/licon';
import { log } from 'lib/permalog';
import { pubsub } from 'lib/pubsub';
import { type Dialog, domDialog, spinnerHtml, confirm, alert } from 'lib/view';
import { text as xhrText } from 'lib/xhr';

import type AnalyseCtrl from '../ctrl';
import type { AnalysisEngineInfo } from '../interfaces';
import { LocalAnalysisEngine, uploadAnalysis, canPublishAnalysis } from './localAnalysisEngine';

type Preset = 'standard' | 'broadcast' | 'custom';

export function localAnalysisDialog(ctrl: AnalyseCtrl): Promise<void> {
  return new LocalAnalysisDialog(ctrl).show();
}

class LocalAnalysisDialog {
  private readonly engine: LocalAnalysisEngine;
  private chartData: Parameters<ChartGame['acpl']>[1];
  private dlg: Dialog;
  private chart: AcplChart;
  private readonly storageKey = `analyse.local.preset.${myUserId() ?? 'anon'}`;
  private mode: { preset: Preset; custom: CustomCeval };
  private readonly presets: Record<Preset, { label: string; title: string; nodes?: number }>;
  private justPublished = false;

  constructor(readonly ctrl: AnalyseCtrl) {
    this.engine = new LocalAnalysisEngine(ctrl, this.updateEngineStatus, this.updateChartData);
    this.presets = {
      standard: { label: i18n.site.standard, title: i18n.localAnalysis.standardQuality, nodes: 1_000_000 },
      broadcast: {
        label: i18n.localAnalysis.broadcast,
        title: i18n.localAnalysis.broadcastQuality,
        nodes: 5_000_000,
      },
      custom: {
        label: i18n.localAnalysis.custom,
        title: i18n.localAnalysis.customQualityXSeconds(ctrl.ceval.info()!.threads < 5 ? 4 : 2),
      },
    };
    this.selectPreset();
    pubsub.on('analysis.server.progress', this.updateView);
  }

  async show() {
    this.dlg = await domDialog({
      class: 'local-analysis-dialog',
      css: [{ hashed: 'analyse.local-dialog' }],
      htmlText: $html`
        <div class="preset-tabs">
          <label>Quality:</label>
          ${this.presetTabsHtml()}
        </div>
        <div class="main-content">
          <div class="preset-infos">${Object.keys(this.presets).map(this.presetInfoHtml).join('')}</div>
          <div class="chart-container none"><canvas class="chart"/></div>
          <div class="working none">
            ${spinnerHtml}
            <span>${i18n.localAnalysis.keepThisBrowserTabActive}</span>
          </div>
        </div>
        <span class="footer">
          <button class="button button-empty button-red cancel-btn none">${i18n.site.cancel}</button>
          <button class="button button-empty button-clas publish-btn none">${
            i18n.localAnalysis.publish
          }</button>
          <p class="status"></p>
          <button class="button analyse-btn">${i18n.localAnalysis.analyse}</button>
          <button class="button ok-btn none">${i18n.site.ok}</button>
        </span>`,
      modal: true,
      onClose: this.onClose,
      actions: [
        { selector: '.preset-tabs', listener: this.clickPreset },
        { selector: '.ok-btn', result: 'ok' },
        { selector: '.cancel-btn', result: 'cancel' },
        { selector: '.publish-btn', listener: this.clickPublish },
        { selector: '.analyse-btn', listener: this.clickAnalyse },
        { selector: '.clear.local', listener: this.clickClearLocal },
        { selector: '.clear.published', listener: this.clickClearPublished },
      ],
    });
    this.chart = await site.asset
      .loadEsm<ChartGame>('chart.game')
      .then(chart => chart.acpl(this.el<HTMLCanvasElement>('.chart')!, this.ctrl.data, this.engine.nodes));
    this.updateView();
    this.dlg.show();
  }

  onClose = () => {
    this.engine.stop();
    pubsub.off('analysis.server.progress', this.updateView);
  };

  updateView = () => {
    if (!this.el('.preset-infos')?.classList.contains('hidden')) {
      this.els('.preset-tab').forEach(btn => btn.classList.remove('active'));
      this.el(`.preset-tab[data-preset="${this.mode.preset}"]`)?.classList.add('active');
      this.els('.preset-info').forEach(div => div.classList.add('none'));
      this.el(`.preset-info[data-preset="${this.mode.preset}"]`)?.classList.remove('none');
    }
    if (this.canUpload.showButton && this.ctrl.idbTree.localAnalysisIsBetter) {
      this.status(i18n.localAnalysis.youCanPublish);
      this.showButtons({ publish: true });
    } else {
      this.status('');
      this.showButtons({ publish: false });
    }
    for (const [pre, info] of Object.entries(this.presets)) {
      this.el(`.preset-tab[data-preset="${pre}"]`)?.classList.toggle(
        'checked',
        Number(info.nodes) <=
          (this.localNpm && this.publishedNpm
            ? Math.max(this.localNpm, this.publishedNpm)
            : this.localNpm || this.publishedNpm),
      );
    }
    if (this.publishedNpm >= Number(this.presets[this.mode.preset].nodes) && !this.justPublished) {
      this.status(i18n.localAnalysis.serverAlreadyHas);
    }
  };

  clickAnalyse = async (): Promise<void> => {
    this.els('.preset-tab:not(.active)')?.forEach(el => el.classList.add('none'));
    this.showButtons({ publish: false, cancel: true, analyse: false });
    this.el('.preset-infos')?.classList.add('hidden');
    this.el('.chart-container')?.classList.remove('none');
    this.el('.working')?.classList.remove('none');
    const then = performance.now();
    try {
      const division = await this.engine.getDivision();
      this.chartData = {
        ...this.ctrl.data,
        game: { ...this.ctrl.data.game, division },
        analysis: { partial: true },
      };
      const result = await this.engine.analyse(this.mode.custom, division);
      await this.ctrl.idbTree.saveAnalysis(result);
      this.status(i18n.localAnalysis.doneInX(((performance.now() - then) / 1000).toFixed(1)));
      this.showButtons({ ok: true, publish: this.canUpload.showButton, cancel: false });
      this.ctrl.mergeLocalAnalysisData(result.localUpdate);
    } catch (e) {
      this.el('.working')?.classList.add('none');
      if (e !== 'cancelled') {
        log(e);
        await alert(String(e));
      }
    }
    this.el('.working')?.classList.add('none');
    this.updateView();
    this.ctrl.redraw();
  };

  clickPublish = async () => {
    if (this.canUpload.whyNot) {
      return await alert(this.canUpload.whyNot);
    }
    if (this.publishedNpm && this.ctrl.study && !this.ctrl.study.canMergeAnalysisCleanly()) {
      if (!(await confirm(i18n.localAnalysis.whenUpgradingOldChapters, i18n.localAnalysis.publish))) return;
    }

    const serverDoc = await this.ctrl.idbTree.serverDocument();
    if (!serverDoc) {
      log(`localAnalysisDialog: getVerified failed for ${this.ctrl.idbTree.id}`);
      this.justPublished = true;
      await this.ctrl.idbTree.clear('analysis');
      this.updateView();
      this.showButtons({ ok: true, analyse: false, publish: false });
      this.status(i18n.site.success);
      return;
    }
    const result = await uploadAnalysis(serverDoc);

    if (result.status === 'locked') {
      await alert(i18n.localAnalysis.serverAnalysisInProgress);
    } else if (result.status === 'error') {
      if (result.errorText) log('analysis upload error', result.errorText);
      this.status(i18n.localAnalysis.analysisUploadFailed);
    } else if (result.status === 'conflict') {
      const useTheirs = await confirm(
        i18n.localAnalysis.looksLikeASimilar,
        i18n.localAnalysis.useTheirs,
        i18n.localAnalysis.keepMine,
      );
      if (useTheirs) {
        await this.ctrl.idbTree.clear('analysis');
        site.reload();
      } else this.dlg.close();
    } else {
      this.justPublished = true;
      this.ctrl.publishedEvalEngine = this.ctrl.staticAnalysis?.engine;
      await this.ctrl.idbTree.clear('analysis');
      this.ctrl.redraw();
      this.updateView();
      this.showButtons({ ok: true, analyse: false, publish: false });
      this.status(i18n.site.success);
    }
  };

  clickPreset = (e: Event) => {
    if (!(e.target instanceof HTMLElement)) return;

    const preset = e.target.dataset.preset as Preset;
    localStorage.setItem(this.storageKey, preset);
    this.selectPreset(preset);
    this.updateView();
  };

  clickClearLocal = async () => {
    if (await confirm(i18n.study.clearLocal)) {
      await this.ctrl.idbTree.clear('analysis');
      site.reload();
    }
  };

  clickClearPublished = async () => {
    if (!this.ctrl.opts.study || !(await confirm(i18n.study.clearPublished))) return;
    try {
      await xhrText(`/analysis/${this.ctrl.opts.study.chapter.id}/${this.ctrl.idbTree.id}`, {
        method: 'DELETE',
      });
      site.reload();
    } catch (e) {
      await alert(String(e));
    }
  };

  selectPreset(preset?: Preset) {
    if (!preset) {
      const nodesToBeat = Math.max(Number(this.localNpm), Number(this.publishedNpm));
      preset = localStorage.getItem(this.storageKey) as Preset;
      if (!(preset in this.presets)) preset = 'standard';
      if (Number(this.presets[preset].nodes) < nodesToBeat) {
        preset = nodesToBeat < this.presets.broadcast.nodes! ? 'broadcast' : 'custom';
      }
    }
    this.mode = this.getMode(preset) ?? this.getMode('custom')!;
  }

  updateEngineStatus = (nodeIndex: number, totalNodes: number, nodesPerMove: number) => {
    let html =
      nodeIndex === 0
        ? i18n.localAnalysis.startingPosition
        : i18n.localAnalysis.plyXOfY(nodeIndex, totalNodes - 1);

    if (this.mode.preset === 'custom' && isFinite(nodesPerMove)) {
      for (const fasterThan of [this.presets.broadcast, this.presets.standard]) {
        const presetNodes = fasterThan.nodes!;
        if (nodesPerMove <= presetNodes) continue;
        const multiplier =
          nodesPerMove / presetNodes < 5
            ? Math.round(10 * (nodesPerMove / presetNodes)) / 10
            : Math.round(nodesPerMove / presetNodes);
        html += `<br>(${i18n.localAnalysis.xTimesYQuality(
          multiplier,
          fasterThan.label.toLocaleLowerCase(),
        )})`;
        break;
      }
    }
    this.status(html);
  };

  status(html: string) {
    this.el('.status')!.innerHTML = html ?? '';
  }

  presetInfoHtml = (preset: Preset) => {
    const param = (label: string, value: string, postfix?: string) =>
      `<label>${label}:</label><p ${postfix !== undefined ? 'class="row-val"' : ''}>${value} ${
        postfix ? postfix : ''
      }</p>`;
    const mode = this.getMode(preset);
    if (!mode) return '';

    const info = this.ctrl.ceval.info(mode.custom)!;

    const projectedQuality = () => {
      if (!('movetime' in info.search.by)) return '';

      const balancedCores = info.threads < 10 ? info.threads : 10 + (info.threads - 10) / 1.5;
      let multiplier = Math.round((balancedCores * info.search.by.movetime) / 300) / 10;
      if (multiplier > 10) multiplier = Math.round(multiplier);
      return param(
        i18n.localAnalysis.projected,
        i18n.localAnalysis.xTimesYQuality(multiplier, i18n.site.standard.toLocaleLowerCase()),
      );
    };

    const searchParam =
      'movetime' in info.search.by
        ? param(i18n.site.time, i18n.site.nbSeconds(Math.round(info.search.by.movetime / 1000)))
        : 'nodes' in info.search.by
          ? param(i18n.localAnalysis.nodes, numberFormat(info.search.by.nodes))
          : '';
    const engineNameParam = param(i18n.localAnalysis.willUse, info.engine?.short ?? info.engine?.name ?? '');
    const titleHtml =
      !this.ctrl.idbTree.hasLocalAnalysis || !this.ctrl.publishedEvalEngine
        ? //      isEquivalent(this.ctrl.publishedEvalEngine, this.ctrl.staticAnalysis?.engine)
          `<span>${this.presets[preset].title}</span>`
        : this.analysisInfoHtml(this.ctrl.publishedEvalEngine);

    return $html`
      <div class="preset-info" data-preset="${preset}">
        ${titleHtml}
        ${this.analysisInfoHtml(this.ctrl.staticAnalysis?.engine)}
        ${this.separator(i18n.localAnalysis.XAnalysis(this.presets[preset].label))}
        ${engineNameParam}
        ${searchParam}
        ${projectedQuality()}
      </div>`;
  };

  analysisInfoHtml(info?: AnalysisEngineInfo) {
    if (!info) return '';
    const isTitleServerPane =
      this.ctrl.idbTree.hasLocalAnalysis && isEquivalent(this.ctrl.publishedEvalEngine, info);
    const isLocalPane = this.ctrl.idbTree.hasLocalAnalysis && !isTitleServerPane;
    const splitVersion = info.engineVersion.split('/');
    const engine =
      splitVersion.length === 3
        ? `fishnet: ${splitVersion[1]}`
        : isLocalPane
          ? info.engineVersion
          : `local: ${info.engineVersion}`;
    const quality =
      info.nodesPerMove === 1_000_000
        ? i18n.site.standard
        : info.nodesPerMove === 5_000_000
          ? i18n.localAnalysis.broadcast
          : i18n.localAnalysis.xTimesYQuality(
              Math.round(info.nodesPerMove / 100_000) / 10,
              i18n.site.standard.toLocaleLowerCase(),
            );
    const provenance = isLocalPane ? i18n.localAnalysis.local : i18n.localAnalysis.server;
    const clearButton = isLocalPane
      ? `<button class="clear local" title="${i18n.study.clearLocal}">${licon.X}</button>`
      : canPublishAnalysis(this.ctrl).allowed // && (isTitleServerPane || !this.ctrl.idbTree.hasLocalAnalysis)
        ? `<button class="clear published" title="${i18n.study.clearPublished}">${licon.X}</button>`
        : '';
    return $html`
      ${isTitleServerPane ? '' : this.separator(i18n.localAnalysis.currentAnalysis)}
      <label>${isTitleServerPane ? i18n.localAnalysis.published : i18n.localAnalysis.using}:</label>
      <p class="row-val">
        ${provenance}
        <span class="note">(${engine})${clearButton}</span>
      </p>
      <label>${i18n.localAnalysis.quality}:</label>
      <p>${quality}</p>
      <label>${i18n.localAnalysis.nodes}:</label>
      <p>${numberFormat(info.nodesPerMove)}</p>`;
  }

  separator(label: string) {
    return `<div class="separator"><hr>${label}<hr></div>`;
  }

  getMode(val: Preset) {
    if (!(val in this.presets)) val = 'standard';
    const id = this.ctrl.ceval.engines.supporting({
      rules: this.ctrl.ceval.rules,
      nonStandardMaterial: this.ctrl.ceval.nonStandardMaterial,
    })[0]?.id;
    if (!id && val !== 'custom') return undefined;
    const search = () =>
      val === 'custom' ? 60_000 : { by: { nodes: this.presets[val].nodes! }, multiPv: 1 };
    const engine =
      val !== 'custom' ? { id, threads: navigator.hardwareConcurrency, hashSize: 256 } : undefined;
    return { preset: val, custom: { search, engine, canBackground: true } };
  }

  presetTabsHtml() {
    return Object.entries(this.presets)
      .filter(([key, _]) => this.getMode(key as Preset))
      .map(
        ([key, info]) =>
          `<button class="preset-tab" data-preset="${key}" title="${info.title}">${info.label}</button>`,
      )
      .join('');
  }

  showButtons(state: { cancel?: boolean; publish?: boolean; analyse?: boolean; ok?: boolean }) {
    Object.entries(state).forEach(([btn, vis]) => this.el(`.${btn}-btn`)?.classList.toggle('none', !vis));
  }

  updateChartData = () => {
    this.chart?.updateData(this.chartData, this.engine.nodes);
  };

  el<T extends HTMLElement>(selector: string) {
    return this.dlg.view.querySelector<T>(selector) ?? undefined;
  }

  els<T extends HTMLElement>(selector: string) {
    return this.dlg.view.querySelectorAll<T>(selector);
  }

  get canUpload() {
    const { allowed, reason } = canPublishAnalysis(this.ctrl);
    const showButton =
      reason === 'rec' ||
      (allowed &&
        this.ctrl.idbTree.localAnalysisIsBetter &&
        (this.mode.preset === 'custom' ||
          this.ctrl.idbTree.localAnalysisNpm === this.presets[this.mode.preset].nodes));

    return { showButton, whyNot: reason === 'rec' ? i18n.localAnalysis.turnOnRec : reason };
  }

  get selectedEngine() {
    return this.ctrl.ceval.info(this.mode.custom)!.engine;
  }

  get localNpm() {
    return Number(this.ctrl.idbTree.localAnalysisNpm);
  }

  get publishedNpm() {
    return Number(this.ctrl.publishedEvalEngine?.nodesPerMove);
  }
}

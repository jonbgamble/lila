import type { ChartGame, AcplChart } from 'chart';
import { h, type VNode } from 'snabbdom';

import { requestIdleCallbackSafe } from 'lib';
import { pubsub } from 'lib/pubsub';
import { alert, bind, confirm, onInsert, spinnerVdom, snabIcon } from 'lib/view';
import { text } from 'lib/xhr';

import type AnalyseCtrl from '../ctrl';
import type { AnalyseData } from '../interfaces';
import { stockfishName } from '../serverSideUnderboard';

export const chartSpinner = (): VNode =>
  h('div#acpl-chart-container-loader', [
    h('span', [stockfishName, h('br'), 'Server analysis']),
    spinnerVdom(),
  ]);

export default class ServerEval {
  requested = false;
  chart?: AcplChart;

  constructor(
    readonly root: AnalyseCtrl,
    readonly chapterId: () => string,
  ) {
    pubsub.on('analysis.server.progress', this.updateChart);
  }

  reset = () => {
    this.requested = false;
  };

  request = () => {
    this.root.socket.send('requestAnalysis', this.chapterId());
    this.requested = true;
  };

  updateChart = (d: AnalyseData) => this.chart?.updateData(d, this.root.mainline);
}

export function view(ctrl: ServerEval): VNode {
  const analysis = ctrl.root.staticAnalysis;

  if (!analysis) return ctrl.requested ? requested() : requestButtons(ctrl);
  const mainline = ctrl.root.mainline;
  const chart = h('canvas.study__server-eval.ready.' + analysis.id, {
    hook: onInsert(el => {
      requestIdleCallbackSafe(async () => {
        (await site.asset.loadEsm<ChartGame>('chart.game'))
          .acpl(el as HTMLCanvasElement, ctrl.root.data, mainline)
          .then(chart => (ctrl.chart = chart));
      }, 800);
    }),
  });

  const loading =
    !ctrl.root.study?.data.chapter?.serverEval?.done && mainline.find(ctrl.root.partialAnalysisCallback);
  const children = [
    chart,
    chartAction('cogs', i18n.site.deviceLocalAnalysis, () =>
      site.asset.loadEsm('analyse.local', { init: ctrl.root }),
    ),
  ];
  if (loading) children.push(chartSpinner());
  if (ctrl.root.study!.members.canContribute())
    children.push(
      chartAction(
        'x',
        i18n.site.delete,
        async () => {
          if (!(await confirm(`${i18n.site.delete}?`, i18n.site.delete))) return;
          try {
            await text(`/analysis/${ctrl.root.study!.data.id}/${ctrl.chapterId()}`, { method: 'DELETE' });
            site.reload();
          } catch (e) {
            await alert(String(e));
          }
        },
        'delete',
      ),
    );
  return h('div.study__server-eval.analysis-chart.ready', children);
}

const chartAction = (icon: 'cogs' | 'x', title: string, action: () => void, cls = ''): VNode =>
  h(
    `button.analysis-chart-action.${cls || 'local-analysis'}`,
    {
      attrs: { type: 'button', title, 'aria-label': title },
      on: { click: e => (e.stopPropagation(), action()) },
    },
    [snabIcon(icon)],
  );

const requested = () => h('div.study__server-eval.requested.padded', spinnerVdom());

function requestButtons(ctrl: ServerEval) {
  const root = ctrl.root;
  return h(
    'div.study__analysis',
    root.mainline.length < 5
      ? h('p', i18n.study.theChapterIsTooShortToBeAnalysed)
      : [
          !root.study!.members.canContribute()
            ? i18n.study.onlyContributorsCanRequestAnalysis
            : h('button.button.text', { hook: bind('click', ctrl.request, root.redraw) }, [
                snabIcon('barChart'),
                i18n.site.requestAServerAnalysis,
              ]),
          h(
            'button.button.text',
            { on: { click: () => site.asset.loadEsm('analyse.local', { init: root }) } },
            [snabIcon('cogs'), i18n.site.deviceLocalAnalysis],
          ),
        ],
  );
}

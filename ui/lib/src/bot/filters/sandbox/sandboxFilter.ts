import type { FilterResult, FilterSpec, FilterInfo } from '@/bot/filter';
import type { SearchMove, MoveArgs } from '@/bot/types';
import { frag } from '@/index';

import iframeBootstrap from './iframeBootstrap.raw.js';
import iframeWorkerPrefix from './iframeWorkerPrefix.raw.js';

/**
sandboxFilter:
- spawns a Web Worker inside an opaque-origin sandboxed iframe to run untrusted code
- no access to real origin's goodies (cookies, localStorage, sessionStorage, cache, idb)

third party script inside the worker:
- can init with top level setup statements
- must provide a 'score' function of type FilterFunction which gets called for each bot move
  with the current movelist, weights, args, and limiter value
- can use chessops via provided co global
- must return a { [uci: string]: number } object that gives existing (or new) uci moves and their weights
- can't do much else
*/

export function makeSandboxFilter(filterJs: string, info: FilterInfo): FilterSpec {
  let worker: Promise<SandboxWorkerProxy>;
  return {
    score: async (moves: SearchMove[], args: MoveArgs, limiter: number): Promise<FilterResult> => {
      worker ??= makeIframeWorkerProxy(filterJs);
      return worker.then(w => w.score({ moves, args, limiter }));
    },
    terminate: () => worker.then(w => w.terminate()),
    info,
  };
}

const nonce = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce ?? '';
let chessopsIife: Promise<string>;

async function makeIframeWorkerProxy(filterJs: string): Promise<SandboxWorkerProxy> {
  chessopsIife ??= fetch(site.asset.url(site.asset.jsModule('chessops.iife'))).then(res => res.text());
  return chessopsIife.then(
    chessops =>
      new Promise<SandboxWorkerProxy>((resolve, reject) => {
        const iframe = frag<HTMLIFrameElement>('<iframe sandbox="allow-scripts" style="display:none">');

        iframe.srcdoc = $html`
          <!doctype html>
          <meta charset="utf-8">
          <meta http-equiv="Content-Security-Policy"
                content="default-src 'none';connect-src 'none';script-src 'nonce-${nonce}';worker-src blob:">
          <script nonce="${nonce}">${iframeBootstrap}<\/script>`;

        iframe.onload = () => {
          const { port1: iframePort, port2: originPort } = new MessageChannel();

          const onMsgFromIframe = (ev: MessageEvent) => {
            if (ev.data.type === 'iframeWorkerIsReady') {
              iframePort.removeEventListener('message', onMsgFromIframe);
              const proxy = new SandboxWorkerProxy(iframe, iframePort);
              resolve(proxy);
            } else if (ev.data.type === 'error') {
              iframePort.removeEventListener('message', onMsgFromIframe);
              iframe.remove();
              reject(new Error(ev.data?.message || 'sandbox bootstrap error'));
            }
          };
          iframePort.addEventListener('message', onMsgFromIframe);
          iframePort.start();

          if (iframe.contentWindow) {
            iframe.contentWindow.postMessage({}, '*', [originPort]);
            iframePort.postMessage({
              type: 'boot',
              workerScript: `${iframeWorkerPrefix}\n${chessops}\n${filterJs}`,
            });
          } else reject(new Error('no iframe.contentWindow'));
        };

        document.documentElement.appendChild(iframe);
      }),
  );
}

class SandboxWorkerProxy {
  private pending?: {
    resolve: (r: FilterResult) => void;
    reject: (e: string) => void;
    timeout: number;
  };

  constructor(
    private readonly iframe: HTMLIFrameElement,
    private readonly iframePort: MessagePort,
  ) {
    this.iframePort.onmessage = this.onMessage;
    this.iframePort.start();
  }

  onMessage = (ev: MessageEvent) => {
    if (ev.data.type !== 'result') {
      return this.onError(ev.data.type === 'error' ? ev.data.message : JSON.stringify(ev.data));
    }
    clearTimeout(this.pending?.timeout);
    this.pending?.resolve(ev.data.result);
    this.pending = undefined;
  };

  onError(err: string): void {
    clearTimeout(this.pending?.timeout);
    this.pending?.reject(err);
    this.pending = undefined;
  }

  terminate(): void {
    this.onError('terminated');
    this.iframePort.postMessage({ type: 'terminate' });
    this.iframePort.close();
    this.iframe.remove();
  }

  score(params: { moves: SearchMove[]; args: MoveArgs; limiter: number }): Promise<FilterResult> {
    const timeoutMs = 200; // ?

    return new Promise<FilterResult>((resolve, reject) => {
      this.pending = {
        timeout: setTimeout(() => this.onError('worker timed out'), timeoutMs),
        resolve,
        reject,
      };
      this.iframePort.postMessage({ type: 'score', params });
    });
  }
}

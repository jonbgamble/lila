import type { SearchMove, MoveArgs } from '@/bot/types';
import type { FilterResult, FilterSpec, FilterInfo } from '@/bot/filter';
import { frag } from '@/index';
import iframeBootstrap from './iframeBootstrap.raw.js';
import iframeWorkerPrefix from './iframeWorkerPrefix.raw.js';

// third party filter:
// - spawns a Web Worker inside an opaque-origin sandboxed iframe
// - no access to real origin's goodies (cookies, localStorage, sessionStorage, cache, idb)
//
// third party script inside the worker:
// - can init with top level setup statements
// - must provide a 'score' function of type FilterFunction which gets called on each bot move
// - can't do much else

export function makeSandboxFilter(filterJs: string, info: FilterInfo): FilterSpec {
  let worker: Promise<IframeWorkerProxy>;
  return {
    score: async (moves: SearchMove[], args: MoveArgs, limiter: number): Promise<FilterResult> => {
      worker ??= makeIframeWorkerProxy(filterJs);
      return worker.then(w => w.score({ moves, args, limiter }));
    },
    terminate: () => worker.then(w => w.terminate()),
    info,
  };
}

let chessopsIife: Promise<string>;

async function makeIframeWorkerProxy(filterJs: string): Promise<IframeWorkerProxy> {
  chessopsIife ??= fetch(site.asset.url(site.asset.jsModule('chessops.iife'))).then(res => res.text());
  return chessopsIife.then(
    chessops =>
      new Promise<IframeWorkerProxy>((resolve, reject) => {
        const iframe = frag<HTMLIFrameElement>('<iframe sandbox="allow-scripts" style="display:none">');
        const workerScript = `${iframeWorkerPrefix}\n${chessops}\n${filterJs}`;
        const bootstrap = $trim`
        <!doctype html>
        <meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="
          default-src 'none';
          connect-src 'none';
          script-src 'nonce-${nonce}';
          worker-src blob:
        ">
        <script nonce="${nonce}">${iframeBootstrap}<\/script>`;

        iframe.srcdoc = bootstrap;
        iframe.onload = () => {
          const { port1: pagePort, port2: iframePort } = new MessageChannel();

          const onMsgFromIframe = (ev: MessageEvent<any>) => {
            if (ev.data.type === 'iframeWorkerIsReady') {
              pagePort.removeEventListener('message', onMsgFromIframe);
              const proxy = new IframeWorkerProxy(iframe, pagePort);
              resolve(proxy);
            } else if (ev.data.type === 'error') {
              pagePort.removeEventListener('message', onMsgFromIframe);
              iframe.remove();
              reject(new Error(ev.data?.message || 'sandbox bootstrap error'));
            }
          };
          pagePort.addEventListener('message', onMsgFromIframe);
          pagePort.start();
          if (iframe.contentWindow) {
            iframe.contentWindow.postMessage({}, '*', [iframePort]);
            pagePort.postMessage({ type: 'boot', workerScript });
          } else reject(new Error('no iframe.contentWindow'));
        };

        document.documentElement.appendChild(iframe);
      }),
  );
}

class IframeWorkerProxy {
  private pending?: {
    resolve: (r: FilterResult) => void;
    reject: (e: string) => void;
    timeout: number;
  };

  constructor(
    private iframe: HTMLIFrameElement,
    private port: MessagePort,
  ) {
    this.port.onmessage = this.onMessage;
    this.port.start();
  }

  onMessage = (ev: MessageEvent<any>) => {
    console.log('onMessage', ev.data);
    if (ev.data.type === 'result') {
      console.log('hoo doggy!', ev.data);
      this.resolve(ev.data.result);
    } else if (ev.data.type === 'error') {
      console.log('ohnoes', ev.data);
      this.reject(ev.data.message);
    } else this.reject(JSON.stringify(ev.data));
  };

  resolve(r: FilterResult): void {
    clearTimeout(this.pending?.timeout);
    this.pending?.resolve(r);
    this.pending = undefined;
  }
  reject(err: string): void {
    clearTimeout(this.pending?.timeout);
    this.pending?.reject(err);
    this.pending = undefined;
  }
  terminate(): void {
    this.reject('terminated');
    this.port.postMessage({ type: 'terminate' });
    this.port.close();
    this.iframe.remove();
  }

  score(params: { moves: SearchMove[]; args: MoveArgs; limiter: number }): Promise<FilterResult> {
    const timeoutMs = 200; // ?

    return new Promise<FilterResult>((resolve, reject) => {
      this.pending = {
        timeout: setTimeout(() => this.reject('worker timed out'), timeoutMs),
        resolve,
        reject,
      };
      this.port.postMessage({ type: 'score', params });
    });
  }
}

const nonce =
  (document.querySelector('script[nonce]') as HTMLScriptElement | null)?.nonce ||
  document.querySelector('meta[name="csp-nonce"]')?.getAttribute('content') ||
  '';

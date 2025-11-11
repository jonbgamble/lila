import type { SearchMove, MoveArgs } from '@/bot/types';
import type { FilterResult, FilterSpec } from '@/bot/filter';
import { frag } from '@/index';
import iframeBootstrap from './iframeBootstrap.raw.js';
import thirdPartyPrefix from './thirdPartyPrefix.raw.js';

//import { Bot } from '@/bot/bot';
// third party filter:
// - spawns a Web Worker inside an opaque-origin sandboxed iframe
// - no access to origin's cookies, localStorage, idb, opfs, etc
//
// third party script inside the worker:
// - can init with top level setup statements
// - must provide a 'score' function of type FilterFunction which gets called on each bot move
// - can't do much else

const nonce =
  (document.querySelector('script[nonce]') as HTMLScriptElement | null)?.nonce ||
  document.querySelector('meta[name="csp-nonce"]')?.getAttribute('content') ||
  '';

export async function makeFilterWorker(userJs: string): Promise<FilterSpec> {
  const scriptText = `${thirdPartyPrefix}\n${userJs}`;
  const worker = await new Promise<PortWrapper>((resolve, reject) => {
    const iframe = frag<HTMLIFrameElement>('<iframe sandbox="allow-scripts" style="display:none">');
    const bootstrap = `<!doctype html><meta charset="utf-8"><script nonce="${nonce}">${iframeBootstrap}<\/script>`;

    iframe.srcdoc = bootstrap;
    iframe.onload = () => {
      const ch = new MessageChannel();
      const portParent = ch.port1;
      const portIframe = ch.port2;

      const onPortMsg = (ev: MessageEvent<any>) => {
        if (ev.data?.type === 'ready') {
          console.log(ev.data.origin);
          portParent.removeEventListener('message', onPortMsg);
          const proxy = new PortWrapper(iframe, portParent);
          resolve(proxy);
        } else if (ev.data?.type === 'error') {
          portParent.removeEventListener('message', onPortMsg);
          iframe.remove();
          reject(new Error(ev.data?.message || 'sandbox bootstrap error'));
        }
      };
      portParent.addEventListener('message', onPortMsg);
      portParent.start();
      if (iframe.contentWindow) {
        iframe.contentWindow.postMessage({}, '*', [portIframe]); // { type: 'init' }, 'null' or '*' here?
        portParent.postMessage({ type: 'boot', code: scriptText });
      } else reject(new Error('no iframe.contentWindow'));
    };

    document.documentElement.appendChild(iframe);
  });

  return {
    score: async (moves: SearchMove[], args: MoveArgs, limiter: number): Promise<FilterResult> => {
      const raw = await worker.score({ moves, args, limiter });

      const result: FilterResult = {};
      for (const [uci, { weight }] of Object.entries(raw)) {
        result[uci] = typeof weight === 'number' ? { weight } : { weight: 0 };
      }
      return result;
    },
    terminate: () => worker.terminate(),
    info: {
      type: 'filter',
      class: ['filter'],
      value: { range: { min: -1, max: 1 }, by: 'avg' },
      label: 'third party demo',
      title: $trim`
        this is a third party yada yada`,
    },
  };
}

class PortWrapper {
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

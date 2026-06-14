export interface FingerprintConfig {
  seed: string;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  languages?: string[];
}

type InitScriptContext = {
  addInitScript<Arg>(script: (arg: Arg) => void, arg?: Arg): Promise<void>;
};

// Runs in the browser before page scripts — must be fully self-contained.
export function fingerprintPatch(cfg: FingerprintConfig): void {
  const seed = cfg.seed;

  function xfnv1a(str: string): number {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function hash32(s: string, index: number): number {
    let h = xfnv1a(`${s}:${index}`);
    h ^= h << 13;
    h >>>= 0;
    h ^= h >> 17;
    h >>>= 0;
    h ^= h << 5;
    h >>>= 0;
    return h;
  }

  function shouldPerturb(index: number): boolean {
    return (hash32(seed, index) & 7) === 0;
  }

  function delta(index: number): number {
    return (hash32(seed, index + 0x9e3779b9) & 1) === 0 ? -1 : 1;
  }

  function perturbBytes(data: ArrayLike<number>, byteOffset: number, length: number, baseIndex: number): void {
    for (let i = 0; i < length; i++) {
      const idx = baseIndex + i;
      if (!shouldPerturb(idx)) continue;
      const arr = data as { [n: number]: number };
      const v = arr[byteOffset + i];
      arr[byteOffset + i] = Math.max(0, Math.min(255, v + delta(idx)));
    }
  }

  function perturbImageData(imageData: ImageData): void {
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      const px = i / 4;
      if (!shouldPerturb(px)) continue;
      d[i] = Math.max(0, Math.min(255, d[i] + delta(px)));
    }
  }

  const nativeToString = Function.prototype.toString;
  const nativeFnMap = new WeakMap<Function, string>();

  function makeNative<F extends Function>(fn: F, nativeName: string): F {
    nativeFnMap.set(fn, `function ${nativeName}() { [native code] }`);
    return fn;
  }

  Function.prototype.toString = new Proxy(nativeToString, {
    apply(target, thisArg, args) {
      if (typeof thisArg === "function" && nativeFnMap.has(thisArg)) {
        return nativeFnMap.get(thisArg)!;
      }
      return Reflect.apply(target, thisArg, args);
    },
  }) as typeof Function.prototype.toString;

  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = makeNative(function getImageData(
    this: CanvasRenderingContext2D,
    ...args: Parameters<CanvasRenderingContext2D["getImageData"]>
  ) {
    const imageData = origGetImageData.apply(this, args);
    perturbImageData(imageData);
    return imageData;
  }, "getImageData");

  function perturbedCanvasDataURL(
    canvas: HTMLCanvasElement,
    origToDataURL: HTMLCanvasElement["toDataURL"],
    ...args: Parameters<HTMLCanvasElement["toDataURL"]>
  ): string {
    const ctx = canvas.getContext("2d");
    if (!ctx || canvas.width === 0 || canvas.height === 0) {
      return origToDataURL.apply(canvas, args);
    }
    const imageData = origGetImageData.call(ctx, 0, 0, canvas.width, canvas.height);
    perturbImageData(imageData);
    const temp = document.createElement("canvas");
    temp.width = canvas.width;
    temp.height = canvas.height;
    temp.getContext("2d")!.putImageData(imageData, 0, 0);
    return origToDataURL.apply(temp, args);
  }

  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = makeNative(function toDataURL(
    this: HTMLCanvasElement,
    ...args: Parameters<HTMLCanvasElement["toDataURL"]>
  ) {
    return perturbedCanvasDataURL(this, origToDataURL, ...args);
  }, "toDataURL");

  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = makeNative(function toBlob(
    this: HTMLCanvasElement,
    callback: BlobCallback,
    ...args: [string?, number?]
  ) {
    const ctx = this.getContext("2d");
    if (!ctx || this.width === 0 || this.height === 0) {
      return origToBlob.call(this, callback, ...args);
    }
    const dataUrl = perturbedCanvasDataURL(this, origToDataURL, ...(args as Parameters<HTMLCanvasElement["toDataURL"]>));
    fetch(dataUrl)
      .then((r) => r.blob())
      .then((blob) => callback(blob))
      .catch(() => origToBlob.call(this, callback, ...args));
  }, "toBlob");

  function patchWebGL(proto: WebGLRenderingContextBase & { readPixels: WebGLRenderingContext["readPixels"] }): void {
    const origReadPixels = proto.readPixels;
    proto.readPixels = makeNative(function readPixels(
      this: WebGLRenderingContext,
      ...args: Parameters<WebGLRenderingContext["readPixels"]>
    ) {
      origReadPixels.apply(this, args);
      const pixels = args[6];
      if (!pixels) return;
      const len = pixels.byteLength ?? (pixels as ArrayBufferView).byteLength;
      const offset = (pixels as ArrayBufferView).byteOffset ?? 0;
      perturbBytes(pixels as unknown as ArrayLike<number>, offset, len, 500_000);
    }, "readPixels");
  }

  patchWebGL(WebGLRenderingContext.prototype);
  if (typeof WebGL2RenderingContext !== "undefined") {
    patchWebGL(WebGL2RenderingContext.prototype as unknown as WebGLRenderingContextBase & {
      readPixels: WebGLRenderingContext["readPixels"];
    });
  }

  const origGetFloatFrequencyData = AnalyserNode.prototype.getFloatFrequencyData as (
    this: AnalyserNode,
    array: Float32Array<ArrayBufferLike>,
  ) => void;
  AnalyserNode.prototype.getFloatFrequencyData = makeNative(function getFloatFrequencyData(
    this: AnalyserNode,
    array: Float32Array<ArrayBufferLike>,
  ) {
    origGetFloatFrequencyData.call(this, array);
    for (let i = 0; i < array.length; i++) {
      if ((hash32(seed, i + 100_000) & 15) !== 0) continue;
      array[i] += delta(i + 100_000) * 0.0001;
    }
  }, "getFloatFrequencyData");

  const origGetChannelData = AudioBuffer.prototype.getChannelData;
  AudioBuffer.prototype.getChannelData = makeNative(function getChannelData(
    this: AudioBuffer,
    channel: number,
  ) {
    const data = origGetChannelData.call(this, channel);
    for (let i = 0; i < data.length; i++) {
      const idx = channel * 1_000_000 + i;
      if ((hash32(seed, idx) & 31) !== 0) continue;
      data[i] += delta(idx) * 1e-7;
    }
    return data;
  }, "getChannelData");

  const navProto = Object.getPrototypeOf(navigator) as Navigator;

  if (cfg.hardwareConcurrency != null) {
    Object.defineProperty(navProto, "hardwareConcurrency", {
      get: makeNative(function hardwareConcurrency() {
        return cfg.hardwareConcurrency!;
      }, "get hardwareConcurrency"),
      configurable: true,
    });
  }

  if (cfg.deviceMemory != null) {
    Object.defineProperty(navProto, "deviceMemory", {
      get: makeNative(function deviceMemory() {
        return cfg.deviceMemory!;
      }, "get deviceMemory"),
      configurable: true,
    });
  }

  if (cfg.languages?.length) {
    Object.defineProperty(navProto, "languages", {
      get: makeNative(function languages() {
        return Object.freeze([...cfg.languages!]);
      }, "get languages"),
      configurable: true,
    });
    Object.defineProperty(navProto, "language", {
      get: makeNative(function language() {
        return cfg.languages![0];
      }, "get language"),
      configurable: true,
    });
  }
}

export async function applyFingerprint(context: InitScriptContext, cfg: FingerprintConfig): Promise<void> {
  await context.addInitScript(fingerprintPatch, cfg);
}

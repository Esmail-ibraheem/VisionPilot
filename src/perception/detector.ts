/**
 * In-browser object detector (COCO-SSD, SSDLite MobileNetV2) loaded from the app's own origin.
 * TensorFlow.js and the model are lazy-loaded so the main bundle stays small.
 */

export interface Detection {
  /** COCO class name, e.g. 'car', 'truck', 'bus', 'person', 'bicycle', 'motorcycle' */
  label: string;
  score: number;
  /** [x, y, width, height] in source pixels */
  bbox: [number, number, number, number];
}

export type DetectorInput = HTMLVideoElement | HTMLCanvasElement | ImageData;

const INTERESTING = new Set(['car', 'truck', 'bus', 'person', 'bicycle', 'motorcycle']);

export class Detector {
  private model: { detect(img: DetectorInput, maxNum?: number, minScore?: number): Promise<Array<{ class: string; score: number; bbox: [number, number, number, number] }>> } | null = null;
  private loading: Promise<void> | null = null;
  backend = '';

  /** Resolve the model URL relative to the page so it works from any base path. */
  static modelUrl(): string {
    return new URL('models/coco-ssd/model.json', document.baseURI).toString();
  }

  load(): Promise<void> {
    if (!this.loading) {
      this.loading = (async () => {
        const tf = await import('@tensorflow/tfjs');
        const cocoSsd = await import('@tensorflow-models/coco-ssd');
        // `?tfBackend=cpu|webgl|wasm` overrides the default (WebGL, falling back to CPU).
        const preferred = new URLSearchParams(location.search).get('tfBackend') ?? 'webgl';
        let ok = false;
        try {
          ok = await tf.setBackend(preferred);
        } catch {
          ok = false;
        }
        if (!ok) await tf.setBackend('cpu');
        await tf.ready();
        this.backend = tf.getBackend();
        this.model = await cocoSsd.load({ base: 'lite_mobilenet_v2', modelUrl: Detector.modelUrl() });
      })();
    }
    return this.loading;
  }

  get ready(): boolean {
    return this.model !== null;
  }

  async detect(input: DetectorInput, minScore = 0.42): Promise<Detection[]> {
    if (!this.model) return [];
    const raw = await this.model.detect(input, 20, minScore);
    return raw
      .filter((d) => INTERESTING.has(d.class))
      .map((d) => ({ label: d.class, score: d.score, bbox: d.bbox }));
  }
}

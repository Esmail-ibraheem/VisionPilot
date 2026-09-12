// Offline check of the perception network: loads the bundled COCO-SSD weights from
// public/models/coco-ssd and runs them (CPU backend, slow but dependency-free) on a synthetic
// front-camera frame captured from the app. Produce the frame with:
//   node scripts/screenshot.mjs --query "skip=14&hud=0" --out screenshots/tmp.png --eval "<see README>"
// which writes 512×288 RGB bytes, base64-encoded, to screenshots/frame.b64.
import fs from 'node:fs';
import * as tf from '@tensorflow/tfjs';
import * as cocoSsd from '@tensorflow-models/coco-ssd';

const dir = 'public/models/coco-ssd/';
const modelJson = JSON.parse(fs.readFileSync(dir + 'model.json', 'utf8'));
const specs = modelJson.weightsManifest.flatMap((g) => g.weights);
const buffers = modelJson.weightsManifest.flatMap((g) => g.paths.map((p) => fs.readFileSync(dir + p)));
const weightData = Buffer.concat(buffers);
const handler = tf.io.fromMemory({ modelTopology: modelJson.modelTopology, weightSpecs: specs, weightData: weightData.buffer.slice(weightData.byteOffset, weightData.byteOffset + weightData.byteLength) });

await tf.setBackend('cpu');
const t0 = Date.now();
const model = await cocoSsd.load({ base: 'lite_mobilenet_v2', modelUrl: handler });
console.log(`model loaded from local files in ${Date.now() - t0} ms`);

const b64 = fs.readFileSync('screenshots/frame.b64', 'utf8').trim();
const rgb = Buffer.from(b64, 'base64');
const W = 512, H = 288;
const img = tf.tensor3d(new Uint8Array(rgb), [H, W, 3], 'int32');
const t1 = Date.now();
const dets = await model.detect(img, 20, 0.4);
console.log(`inference ${Date.now() - t1} ms, ${dets.length} detections`);
for (const d of dets) console.log(`  ${d.class} ${(d.score * 100).toFixed(0)}% @ [${d.bbox.map((v) => v.toFixed(0)).join(', ')}]`);

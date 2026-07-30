import fs from 'node:fs';
import NodeModule from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpenCVModule } from '../src/image/opencv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Load the browser OpenCV.js bundle under Node without maintaining a second build. */
export async function loadNodeOpenCv(
  opencvPath: string = path.resolve(__dirname, '../public/opencv.js'),
): Promise<OpenCVModule> {
  const code = fs.readFileSync(opencvPath, 'utf8');
  const mod = new NodeModule(opencvPath);
  mod.filename = opencvPath;
  mod.paths = NodeModule._nodeModulePaths(path.dirname(opencvPath));
  (mod as unknown as { _compile(code: string, filename: string): void })._compile(code, opencvPath);
  return await Promise.resolve(mod.exports) as OpenCVModule;
}

import path from 'path';
import fs from 'fs-extra';
import { IS_PROD } from '../config';
import gatherJS from '../gatherJS';
import wrapJS from '../wrapJS';


export default async (ctx) => {
  const { dobiConfig, log } = ctx.state;
  ctx.assert(dobiConfig, 500, 'getSchema: missing dobiConfig from state');
  ctx.assert(log, 500, 'getSchema: missing log from config');
  const { pkgDir } = dobiConfig;
  ctx.assert(pkgDir, 500, 'getSchema: missing pkgDir from config');
  const { id, version } = ctx.params;

  ctx.set('Content-Type', 'text/javascript');
  let data;
  try {
    if (IS_PROD) {
      const cachePath = path.join(pkgDir, id, version, 'main.js');
      const exists = await fs.exists(cachePath);
      log(`[getMainJs] cachePath: ${cachePath} | exists? ${exists}`);
      ctx.assert(exists, 404);
      data = await fs.readFile(cachePath, 'utf-8');
    } else {
      const assets = await gatherJS([], pkgDir, id, version);
      log(`[getMainJs] wrapping assets: ${pkgDir}/${id}/${version}`);
      data = await wrapJS(assets);
    }
  } catch (err) {
    ctx.throw(400, err);
  }
  ctx.assert(data, 404);
  ctx.body = data;
};

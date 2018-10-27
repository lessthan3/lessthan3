// Dependencies
import express from 'express';
import findit from 'findit';
import path from 'path';
import connectFB from './firebaseUtils';
import Watcher from './Watcher';
import partial from './partial';
import gatherJS from './gatherJS';
import wrapJS from './wrapJS';
import gatherCSS from './gatherCSS';
import wrapCSS from './wrapCSS';
import { IS_PROD, USER_CONNECT_PATH } from './config';
import {
  auth,
  asyncWrapper,
  error,
  getCachedFile,
  getPackage,
  readConfig,
  readSchema,
  setContentType,
} from './helpers';

import {
  asyncExists,
  asyncReaddir,
  asyncStat,
  asyncWriteFile,
} from '../utils';

const defaultCacheFunction = (config, fn) => async (req, res) => {
  await fn(req, res, (data) => {
    res.send(data)
  });
};

const defaultFlushCache = async () => {};

/**
 *
 * @param {Object} config
 * @param {Function} [config.cacheFunction]
 * @param {Function} config.flushCache
 * @param {string} config.cacheAge='1 day'
 * @param {Object} config.firebase
 * @param {string} config.firebase.credential
 * @param {string} config.firebase.databaseURL
 * @param {string} config.pkgDir
 * @param {boolean} config.watch
 */
export default (config) => {
  const {
    apiDir,
    cacheFunction: cache = defaultCacheFunction,
    flushCache = defaultFlushCache,
    cacheAge = '1 day',
    firebase: fbConfig = {},
    pkgDir,
    watch,
  } = config || {};
  const firebase = connectFB(fbConfig);


  // Watch For File Changes
  let watcher;
  if (watch) {
    watcher = new Watcher({ firebase, pkgDir });
  }

  // routes
  const allowCORS = (req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    return next();
  };

  // TODO: fix this
  const devConnect = async (req, res) => {
    const {
      user: {
        _id: userId,
      } = {},
    } = req.query;
    watcher.setUserId(userId);
    const fileContents = JSON.stringify({
      timestamp: Date.now(),
      user_id: userId,
    }, null, 2);

    await asyncWriteFile(USER_CONNECT_PATH, fileContents, 'utf8');
    const packages = {};

    const pkgDirs = await asyncReaddir(pkgDir);
    const promises = Object.values(pkgDirs).map(async (id) => {
      packages[id] = {};
      const pkgPath = `${pkgDir}/${id}`;
      try {
        if (!(await asyncStat(pkgPath)).isDirectory()) {
          return;
        }
        const versions = await asyncReaddir(pkgPath);
        for (const version of Object.values(versions)) {
          packages[id][version] = 1;
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('WARNING: ', err);
      }
    });

    await Promise.all(promises);
    return res.send(packages);
  };

  const getConfig = async (req, res, next) => {
    const { id, version } = req.params;
    setContentType(res, 'application/json');
    return cache({ age: cacheAge }, async (_req, _res, _next) => {
      const data = await readConfig(pkgDir, id, version);
      return _next(data);
    })(req, res, next);
  };

  const getSchema = async (req, res, next) => {
    const { id, version } = req.params;
    setContentType(res, 'application/json');
    return cache({ age: cacheAge }, async (_req, _res, _next) => {
      const data = await readSchema(pkgDir, id, version);
      return _next(data);
    })(req, res, next);
  };

  const getFiles = (req, res) => {
    const { id, version } = req.params;
    setContentType(res, 'application/json');
    const root = path.join(getPackage(pkgDir, id, version));

    const files = [];
    const finder = findit(root);
    finder.on('file', file => files.push({
      ext: path.extname(file).replace(/^\./, ''),
      path: file.replace(`${root}${path.sep}`, ''),
    }));
    return finder.on('end', () => res.send(files));
  };

  const getPartialJsMap = async (req, res, next) => {
    req.params.ext = 'js.map';
    const p = partial(pkgDir);
    return p(req, res, next);
  };


  const getMainJs = async (req, res, next) => {
    const { id, version } = req.params;
    setContentType(res, 'text/javascript');

    return cache({ age: cacheAge }, async (_req, _res, _next) => {
      if (IS_PROD) {
        try {
          const data = await getCachedFile({ id, pkgDir, version });
          if (data) {
            return _next(data);
          }
          return error(_res, 404);
        } catch (err) {
          return error(_res, 400, err);
        }
      } else {
        try {
          const assets = await gatherJS([], pkgDir, id, version);
          const data = await wrapJS(assets);
          return _next(data);
        } catch (err) {
          return error(_res, 400, err);
        }
      }
    })(req, res, next);
  };

  const getStyleCSS = async (req, res, next) => {
    const { params: { id, version }, query } = req;
    setContentType(res, 'text/css');
    return cache({ age: cacheAge, qs: true }, async (_req, _res, _next) => {
      // validate input
      for (const value of Object.values(query)) {
        if (!/^[A-Za-z0-9_+@/\-.#$:;\s[\]]*$/.test(value)) {
          return error(_res, 400, 'invalid query parameter');
        }
      }

      try {
        const assets = await gatherCSS([], pkgDir, id, version);
        const data = await wrapCSS(assets, query);
        return _next(data);
      } catch (err) {
        return error(_res, 400, err);
      }
    })(req, res, next);
  };

  const getStaticFiles = async (req, res) => {
    const {
      0: file,
      id,
      version,
    } = req.params;

    // validate input
    if (!/^[A-Za-z0-9+@/_\-.]+$/.test(file)) {
      return error(res, 400, 'not a valid filename');
    }

    const filePath = path.join(`${getPackage(pkgDir, id, version)}`, 'public', file);
    const exists = await asyncExists(filePath);
    if (exists) {
      return res.sendFile(filePath, { maxAge: 1000 * 60 * 5 });
    }
    if (IS_PROD) {
      return error(res, 404, 'File does not exists');
    }
    return error(res, 404, `File ${file} does not exists`);
  };

  // API Calls
  const apiCallHandler = async (req, res, next) => {
    const {
      0: method,
      id,
      version,
    } = req.params;

    const packagePath = path.join(`${getPackage(apiDir, id, version)}`);
    const apiPath = path.join(packagePath, 'api.js');
    const apiExists = await asyncExists(apiPath);
    if (!apiExists) {
      return error(res, 404);
    }


    // eslint-disable-next-line global-require,import/no-dynamic-require
    const svr = (await import(apiPath)).default;
    if (!(svr != null ? svr[method] : undefined)) {
      return error(res, 404);
    }

    // pass arguments in as a single argument map
    // also keep that data the scope for backwards compatibility (to deprecate)
    const args = {
      admin: req.admin,
      body: req.body,
      cache: (options, fn) => cache(options, fn)(req, res, next),
      db: req.db,
      decodeLegacySecret: req.decodeLegacySecret,
      error,
      fbAdmin: req.fbAdmin,
      fbAdminPrimary: req.fbAdminPrimary,
      fbAdminShards: req.fbAdminShards,
      flushCache,
      generateAdminToken: req.generateAdminToken,
      method: req.method,
      mongoFbAdmin: req.mongoFbAdmin,
      next,
      primaryFirebaseShard: req.primaryFirebaseShard,
      query: req.query,
      req,
      res,
      user: req.user,
    };
    return await svr[method].apply(args, [args]);
  };

  // Middleware
  return (req, res, next) => {
    // Routes
    const router = express.Router();

    // Access Control Allow Origin
    router.get('*', allowCORS);

    // Development Token
    if (!IS_PROD) {
      router.get('/connect', asyncWrapper(devConnect));
    }

    // Package Config
    router.get('/pkg/:id/:version/config.json', asyncWrapper(getConfig));

    // Package Schema
    router.get('/pkg/:id/:version/schema.json', asyncWrapper(getSchema));

    // Package Files
    if (!IS_PROD) {
      router.get('/pkg/:id/:version/files.json', getFiles);
    }

    // Package Single File Reload
    if (!IS_PROD) {
      router.get('/pkg/:id/:version/partial.:ext', asyncWrapper(partial(pkgDir)));
      router.get('/pkg/:id/:version/partial.js.map', asyncWrapper(getPartialJsMap));
    }

    // Package Javascript
    router.get('/pkg/:id/:version/main.js', asyncWrapper(getMainJs));

    // Package Stylesheet
    router.get('/pkg/:id/:version/style.css', asyncWrapper(getStyleCSS));

    // Public/Static Files
    router.get('/pkg/:id/:version/public/*', asyncWrapper(getStaticFiles));

    // API Calls
    router.get('/pkg/:id/:version/api/*', auth, asyncWrapper(apiCallHandler));
    router.post('/pkg/:id/:version/api/*', auth, asyncWrapper(apiCallHandler));

    return router.handle(req, res, next);
  };
};
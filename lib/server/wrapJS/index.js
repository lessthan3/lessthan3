'use strict';

const wrap = require('dobi-asset-wrap');
const { USE_COMPRESSION } = require('../config');

/**
 *
 * @param {Object} checked
 * @param {string} str
 * @param {Object} data
 * @return {string}
 */
const check = (checked, str, data = null) => {
  let result;
  if (checked[str]) {
    return '';
  }
  // eslint-disable-next-line no-param-reassign
  checked[str] = 1;
  if (data) {
    result = `;${str}=${JSON.stringify(data)};`;
  } else {
    result = `;if(${str}==null){${str}={};};`;
  }
  return result;
};

/**
 * @description wrap js
 * @param {[]} list
 * @return {Promise<any>}
 */
const wrapJS = list => new Promise((resolve, reject) => {
  const js = new wrap.Assets(list, {
    compress: USE_COMPRESSION,
  }, ((wrapErr) => {
    let header = '';
    if (wrapErr) {
      return reject(wrapErr);
    }

    // generate package header
    try {
      const checked = [];

      for (const jsAsset of js.assets) {
        const lt3 = 'window.lt3';
        const pkg = 'lt3.pkg';
        const pkgId = `lt3.pkg['${jsAsset.pkg_config.id}']`;
        const pkgIdVersion = `${pkgId}['${jsAsset.pkg_config.version}']`;
        const pres = `${pkgIdVersion}.Presenters`;
        const tmpl = `${pkgIdVersion}.Templates`;
        const page = `${pkgIdVersion}.Pages`; // TODO: deprecate

        if (jsAsset.pkg_config.core) {
          for (const s of [lt3, pkg, pkgId, pkgIdVersion, pres, tmpl, page]) {
            header += check(checked, s);
          }
          header += check(checked, `${pkgIdVersion}.config`, jsAsset.pkg_config);
          header += check(checked, `${pkgIdVersion}.schema`, jsAsset.pkg_schema);
        }

        if (['app', 'theme', 'site'].includes(jsAsset.pkg_config.type)) {
          for (const s of [lt3, pkg, pkgId, pkgIdVersion, pres, tmpl, page]) {
            header += check(checked, s);
          }
          header += check(checked, `${pkgIdVersion}.config`, jsAsset.pkg_config);
          header += check(checked, `${pkgIdVersion}.schema`, jsAsset.pkg_schema);
        }
      }
    } catch (err) {
      return reject(err);
    }

    // merge assets
    const asset = js.merge((err) => {
      if (err) {
        return reject(err);
      }
      return resolve(header + asset.data);
    });
    return null;
  }));
});

module.exports = wrapJS;
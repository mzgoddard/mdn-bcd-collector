//
// mdn-bcd-collector: test-builder/javascript.ts
// Functions directly related to building all of the JavaScript tests
//
// © Gooborg Studios, Google LLC, Mozilla Corporation, Apple Inc
// See the LICENSE file for copyright details
//

import {getCustomTest, compileCustomTest, compileTest} from "./common.js";

import type {RawTestCodeExpr} from "../types/types.js";

const stripAttrName = (name, featureName) =>
  name
    .replace(`%${featureName}%`, featureName)
    .replace(`${featureName}.prototype.`, '')
    .replace(`${featureName}.`, '')
    .replace('()', '')
    .replace(`${featureName}[`, 'prototype[')
    .replace(/prototype\[@@(\w+)\]/g, '@@$1');

const buildTestList = (specJS, customJS) => {
  const features = {};

  // Iterate through the spec data
  // XXX use proper typedef instead of any[] once the package is used
  for (const feat of specJS as any[]) {
    const featureName = feat.name.replace('()', '');

    if (['function', 'global-property'].includes(feat.type)) {
      // Functions and global properties will not have members or any other data we need to pull
      features[featureName] = {};
      continue;
    }

    features[featureName] = {members: {static: [], instance: []}};

    // If there is a constructor, determine parameters
    if (feat.type === 'class' && feat.classConstructor) {
      features[featureName].ctor = {
        use_new: feat.classConstructor.usage !== 'call',
        optional_args: feat.classConstructor.parameters.required === 0,
      };
    }

    // Collect static attributes
    const staticAttrs = [
      ...(feat.staticProperties || []),
      ...(feat.staticMethods || []),
    ];

    // Collect instance attributes
    const instanceAttrs = [
      ...(feat.prototypeProperties || []),
      ...(feat.instanceMethods || []),
      ...(feat.instanceProperties || []),
    ];

    // Collect names of all attributes
    for (const attr of [
      ...staticAttrs.map((a) => ({...a, static: true})),
      ...instanceAttrs,
    ]) {
      const prototypeString = `${featureName}.prototype`;
      if (attr.name === prototypeString) {
        continue;
      }

      features[featureName].members[attr.static ? 'static' : 'instance'].push(
        stripAttrName(attr.name, featureName),
      );
    }
  }

  // XXX Iterate through custom data here

  return features;
};

const getCategory = (pathParts: string[]) => {
  let category = 'javascript.builtins';
  const isInSubcategory =
    pathParts.length > 1 &&
    ['Intl', 'WebAssembly', 'Temporal'].includes(pathParts[0]);

  if (isInSubcategory) {
    category += '.' + pathParts[0];
  }

  return category;
};

const buildTest = async (
  tests,
  path: string,
  data: {static?: boolean} = {},
) => {
  const basePath = 'javascript.builtins';
  const parts = path.replace(basePath, '').split('.');
  const category = getCategory(parts);
  const isInSubcategory = category !== basePath;

  let expr: string | RawTestCodeExpr | (string | RawTestCodeExpr)[] = '';

  // We should be looking for an exact match if we're checking for a subfeature not
  // defined on the object prototype (in other words, static members and functions)
  const exactMatchNeeded =
    path.replace(category, '').split('.').length < 2 || data.static;

  const customTest = await getCustomTest(path, category, exactMatchNeeded);

  if (customTest.test) {
    tests[path] = compileTest({
      raw: {code: customTest.test},
      exposure: ['Window'],
    });
  } else {
    // Get the last part as the property and everything else as the expression
    // we should test for existence in, or "self" if there's just one part.
    let property = parts[parts.length - 1];

    if (property.startsWith('@@')) {
      property = `Symbol.${property.substr(2)}`;
    }

    const owner =
      parts.length > 1
        ? parts.slice(0, parts.length - 1).join('.') +
          (data.static === false ? '.prototype' : '')
        : 'self';

    expr = [{property, owner, skipOwnerCheck: isInSubcategory}];

    if (isInSubcategory) {
      if (parts[1] !== property) {
        expr.unshift({property: parts[1], owner: parts[0]});
      } else if (parts[0] !== property) {
        expr.unshift({property: parts[0], owner: 'self'});
      }
    }

    tests[path] = compileTest({
      raw: {code: expr},
      exposure: ['Window'],
    });

    // Add the additional tests
    for (const [key, code] of Object.entries(customTest.additional)) {
      tests[`${path}.${key}`] = compileTest({
        raw: {code: code},
        exposure: ['Window'],
      });
    }
  }
};

const buildConstructorTests = async (tests, path: string, data: any = {}) => {
  const parts = path.split('.');
  const iface = parts[parts.length - 1];
  const category = getCategory(parts);

  const customTest = await getCustomTest(path, category, true);

  let baseCode = '';

  baseCode += `if (!("${parts[2]}" in self)) {
    return {result: false, message: '${parts[2]} is not defined'};
  }
  `;

  if (path.startsWith('Intl')) {
    baseCode += `if (!("${parts[3]}" in Intl)) {
    return {result: false, message: 'Intl.${parts[3]} is not defined'};
  }
  `;
  } else if (path.startsWith('WebAssembly')) {
    baseCode += `if (!("${parts[3]}" in WebAssembly)) {
    return {result: false, message: 'WebAssembly.${parts[3]} is not defined'};
  }
  `;
  }

  if (customTest.test) {
    tests[path] = compileTest({
      raw: {code: customTest.test},
      exposure: ['Window'],
    });
  } else {
    tests[path] = compileTest({
      raw: {
        code: (
          await compileCustomTest(
            baseCode +
              `return bcd.testConstructor("${iface}", {useNew: ${data.use_new}})`,
          )
        ).code,
      },
      exposure: ['Window'],
    });
  }

  if (data.use_new) {
    const ctorNoArgsCode = `try {
            ${iface}();
            return false;
          } catch(e) {
            if (e)
            return {result: false, message: e.message};
          }`;
    tests[`${path}.new_required`] = compileTest({
      raw: {
        code: (
          await compileCustomTest(
            baseCode + `return bcd.testConstructorNewRequired("${iface}")`,
          )
        ).code,
      },
      exposure: ['Window'],
    });
  }

  if (data.optional_args) {
    tests[`${path}.constructor_without_parameters`] = compileTest({
      raw: {
        code: (
          await compileCustomTest(
            baseCode +
              `try {
            new ${iface}();
            return true;
          } catch(e) {
            return {result: false, message: e.message};
          }`,
          )
        ).code,
      },
      exposure: ['Window'],
    });
  }

  // Add the additional tests
  for (const [key, code] of Object.entries(customTest.additional)) {
    tests[`${path}.${key}`] = compileTest({
      raw: {code: code},
      exposure: ['Window'],
    });
  }
};

const build = async (specJS, customJS) => {
  const tests = {};

  const features = buildTestList(specJS, customJS);

  for (const [featureName, featureData] of Object.entries(features) as any[]) {
    const bcdPath = ['javascript', 'builtins', featureName].join('.');
    await buildTest(tests, bcdPath);

    if (featureData.ctor) {
      await buildConstructorTests(
        tests,
        `${bcdPath}.${featureName}`,
        featureData.ctor,
      );
    }

    if (featureData.members) {
      for (const sm of featureData.members.static) {
        await buildTest(tests, `${bcdPath}.${sm}`, {static: true});
      }

      for (const im of featureData.members.instance) {
        await buildTest(tests, `${bcdPath}.${im}`, {static: false});
      }
    }
  }

  return tests;
};

export {build};

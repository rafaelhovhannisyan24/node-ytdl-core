const querystring = require('querystring');
const Cache = require('./cache');
const utils = require('./utils');
const vm = require('vm');

const policy = trustedTypes.createPolicy(`${Math.random}default`, {
  createHTML: input => input,
  createScript: input => input,
  createScriptURL: input => input,
});


// A shared cache to keep track of html5player js functions.
exports.cache = new Cache(1);

/**
 * Extract signature deciphering and n parameter transform functions from html5player file.
 *
 * @param {string} html5playerfile
 * @param {Object} options
 * @returns {Promise<Array.<string>>}
 */
exports.getFunctions = (html5playerfile, options) => exports.cache.getOrSet(html5playerfile, async() => {
  const body = await utils.exposedMiniget(html5playerfile, options).text();
  const functions = exports.extractFunctions(body);
  exports.cache.set(html5playerfile, functions);
  return functions;
});

const VARIABLE_PART = '[a-zA-Z_\\$][a-zA-Z_0-9\\$]*';
const VARIABLE_PART_DEFINE = `\\"?${VARIABLE_PART}\\"?`;
const BEFORE_ACCESS = '(?:\\[\\"|\\.)';
const AFTER_ACCESS = '(?:\\"\\]|)';
const VARIABLE_PART_ACCESS = BEFORE_ACCESS + VARIABLE_PART + AFTER_ACCESS;
const REVERSE_PART = ':function\\(\\w\\)\\{(?:return )?\\w\\.reverse\\(\\)\\}';
const SLICE_PART = ':function\\(\\w,\\w\\)\\{return \\w\\.slice\\(\\w\\)\\}';
const SPLICE_PART = ':function\\(\\w,\\w\\)\\{\\w\\.splice\\(0,\\w\\)\\}';
const SWAP_PART = ':function\\(\\w,\\w\\)\\{' +
    'var \\w=\\w\\[0\\];\\w\\[0\\]=\\w\\[\\w%\\w\\.length\\];\\w\\[\\w(?:%\\w.length|)\\]=\\w(?:;return \\w)?\\}';

const DECIPHER_REGEXP =
    `function(?: ${VARIABLE_PART})?\\(([a-zA-Z])\\)\\{` +
    `\\1=\\1\\.split\\(""\\);\\s*` +
    `((?:(?:\\1=)?${VARIABLE_PART}${VARIABLE_PART_ACCESS}\\(\\1,\\d+\\);)+)` +
    `return \\1\\.join\\(""\\)` +
    `\\}`;

const HELPER_REGEXP =
    `var (${VARIABLE_PART})=\\{((?:(?:${
      VARIABLE_PART_DEFINE}${REVERSE_PART}|${
      VARIABLE_PART_DEFINE}${SLICE_PART}|${
      VARIABLE_PART_DEFINE}${SPLICE_PART}|${
      VARIABLE_PART_DEFINE}${SWAP_PART
    }),?\\n?)+)\\};`;

const FUNCTION_TCE_REGEXP =
    'function(?:\\s+[a-zA-Z_\\$][a-zA-Z0-9_\\$]*)?\\(\\w\\)\\{' +
    '\\w=\\w\\.split\\((?:""|[a-zA-Z0-9_$]*\\[\\d+])\\);' +
    '\\s*((?:(?:\\w=)?[a-zA-Z_\\$][a-zA-Z0-9_\\$]*(?:\\[\\"|\\.)[a-zA-Z_\\$][a-zA-Z0-9_\\$]*(?:\\"\\]|)\\(\\w,\\d+\\);)+)' +
    'return \\w\\.join\\((?:""|[a-zA-Z0-9_$]*\\[\\d+])\\)}';

const N_TRANSFORM_REGEXP =
    'function\\(\\s*(\\w+)\\s*\\)\\s*\\{' +
    'var\\s*(\\w+)=(?:\\1\\.split\\(.*?\\)|String\\.prototype\\.split\\.call\\(\\1,.*?\\)),' +
    '\\s*(\\w+)=(\\[.*?]);\\s*\\3\\[\\d+]' +
    '(.*?try)(\\{.*?})catch\\(\\s*(\\w+)\\s*\\)\\s*\\{' +
    '\\s*return"[\\w-]+([A-z0-9-]+)"\\s*\\+\\s*\\1\\s*}' +
    '\\s*return\\s*(\\2\\.join\\(""\\)|Array\\.prototype\\.join\\.call\\(\\2,.*?\\))};';

const N_TRANSFORM_TCE_REGEXP =
    'function\\(\\s*(\\w+)\\s*\\)\\s*\\{' +
    '\\s*var\\s*(\\w+)=\\1\\.split\\(\\1\\.slice\\(0,0\\)\\),\\s*(\\w+)=\\[.*?];' +
    '.*?catch\\(\\s*(\\w+)\\s*\\)\\s*\\{' +
    '\\s*return(?:"[^"]+"|\\s*[a-zA-Z_0-9$]*\\[\\d+])\\s*\\+\\s*\\1\\s*}' +
    '\\s*return\\s*\\2\\.join\\((?:""|[a-zA-Z_0-9$]*\\[\\d+])\\)};';

const TCE_GLOBAL_VARS_REGEXP =
    '(?:^|[;,])\\s*(var\\s+([\\w$]+)\\s*=\\s*' +
    '(?:' +
    "([\"'])(?:\\\\.|[^\\\\])*?\\3" +
    '\\s*\\.\\s*split\\((' +
    "([\"'])(?:\\\\.|[^\\\\])*?\\5" +
    '\\))' +
    '|' +
    "\\[\\s*(?:([\"'])(?:\\\\.|[^\\\\])*?\\6\\s*,?\\s*)+\\]" +
    '))(?=\\s*[,;])';

const PATTERN_PREFIX = `(?:^|,)\\"?(${VARIABLE_PART})\\"?`;
const REVERSE_PATTERN = new RegExp(PATTERN_PREFIX + REVERSE_PART, 'm');
const SLICE_PATTERN = new RegExp(PATTERN_PREFIX + SLICE_PART, 'm');
const SPLICE_PATTERN = new RegExp(PATTERN_PREFIX + SPLICE_PART, 'm');
const SWAP_PATTERN = new RegExp(PATTERN_PREFIX + SWAP_PART, 'm');

const DECIPHER_ARGUMENT = 'sig';
const N_ARGUMENT = 'ncode';
const DECIPHER_FUNC_NAME = 'DisTubeDecipherFunc';
const N_TRANSFORM_FUNC_NAME = 'DisTubeNTransformFunc';

const extractDollarEscapedFirstGroup = (pattern, text) => {
  const match = text.match(pattern);
  return match ? match[1].replace(/\$/g, '\\$') : null;
};

const extractDecipherFunc = body => {
  try {
    const helperMatch = body.match(new RegExp(HELPER_REGEXP, 's'));
    if (!helperMatch) return null;

    const helperObject = helperMatch[0];
    const actionBody = helperMatch[2];
    const helperName = helperMatch[1];

    const reverseKey = extractDollarEscapedFirstGroup(REVERSE_PATTERN, actionBody);
    const sliceKey = extractDollarEscapedFirstGroup(SLICE_PATTERN, actionBody);
    const spliceKey = extractDollarEscapedFirstGroup(SPLICE_PATTERN, actionBody);
    const swapKey = extractDollarEscapedFirstGroup(SWAP_PATTERN, actionBody);

    const quotedFunctions = [reverseKey, sliceKey, spliceKey, swapKey]
      .filter(Boolean)
      .map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

    if (quotedFunctions.length === 0) return null;

    let funcMatch = body.match(new RegExp(DECIPHER_REGEXP, 's'));
    let isTce = false;
    let decipherFunc;

    if (funcMatch) {
      decipherFunc = funcMatch[0];
    } else {
      const tceFuncMatch = body.match(new RegExp(FUNCTION_TCE_REGEXP, 's'));
      if (!tceFuncMatch) return null;

      decipherFunc = tceFuncMatch[0];
      isTce = true;
    }

    let tceVars = '';
    if (isTce) {
      const tceVarsMatch = body.match(new RegExp(TCE_GLOBAL_VARS_REGEXP, 'm'));
      if (tceVarsMatch) {
        tceVars = `${tceVarsMatch[1]};\n`;
      }
    }

    const resultFunc = `${tceVars + helperObject}\nvar ${DECIPHER_FUNC_NAME}=${decipherFunc};\n`;
    const callerFunc = `${DECIPHER_FUNC_NAME}(${DECIPHER_ARGUMENT});`;

    return resultFunc + callerFunc;
  } catch (e) {
    console.error('Error in extractDecipherFunc:', e);
    return null;
  }
};

const extractNTransformFunc = body => {
  try {
    let nMatch = body.match(new RegExp(N_TRANSFORM_REGEXP, 's'));
    let isTce = false;
    let nFunction;

    if (nMatch) {
      nFunction = nMatch[0];
    } else {
      const nTceMatch = body.match(new RegExp(N_TRANSFORM_TCE_REGEXP, 's'));
      if (!nTceMatch) return null;

      nFunction = nTceMatch[0];
      isTce = true;
    }

    const paramMatch = nFunction.match(/function\s*\(\s*(\w+)\s*\)/);
    if (!paramMatch) return null;

    const paramName = paramMatch[1];

    const cleanedFunction = nFunction.replace(
      new RegExp(`if\\s*\\(typeof\\s*[^\\s()]+\\s*===?.*?\\)return ${paramName}\\s*;?`, 'g'),
      '',
    );

    let tceVars = '';
    if (isTce) {
      const tceVarsMatch = body.match(new RegExp(TCE_GLOBAL_VARS_REGEXP, 'm'));
      if (tceVarsMatch) {
        tceVars = `${tceVarsMatch[1]};\n`;
      }
    }

    const resultFunc = `${tceVars}var ${N_TRANSFORM_FUNC_NAME}=${cleanedFunction};\n`;
    const callerFunc = `${N_TRANSFORM_FUNC_NAME}(${N_ARGUMENT});`;

    return resultFunc + callerFunc;
  } catch (e) {
    console.error('Error in extractNTransformFunc:', e);
    return null;
  }
};

let decipherWarning = false;
let nTransformWarning = false;

const getExtractFunction = (extractFunctions, body, postProcess = null) => {
  for (const extractFunction of extractFunctions) {
    try {
      const func = extractFunction(body);
      if (!func) continue;
      return new vm.Script(postProcess ? postProcess(func) : func);
    } catch (err) {
      console.error('Failed to extract function:', err);
      continue;
    }
  }
  return null;
};

const extractDecipher = body => {
  const decipherFunc = getExtractFunction([extractDecipherFunc], body);
  if (!decipherFunc && !decipherWarning) {
    console.error('Could not parse decipher function');
    decipherWarning = true;
  }
  return decipherFunc;
};

const extractNTransform = body => {
  const nTransformFunc = getExtractFunction([extractNTransformFunc], body);

  if (!nTransformFunc && !nTransformWarning) {
    // This is optional, so we can continue if it's not found, but it will bottleneck the download.
    console.error('Could not parse transform function');
    nTransformWarning = true;
  }

  return nTransformFunc;
};

exports.extractFunctions = body => [extractDecipher(body), extractNTransform(body)];

exports.setDownloadURL = (format, decipherScript, nTransformScript) => {
  if (!format) return;

  const decipher = url => {
    const args = querystring.parse(url);
    if (!args.s || !decipherScript) return args.url;

    try {
      const components = new URL(decodeURIComponent(args.url));
      const context = {};
      context[DECIPHER_ARGUMENT] = decodeURIComponent(args.s);

      decipherScript.code = policy.createScript(decipherScript.code);
      components.searchParams.set(args.sp || 'sig', decipherScript.runInNewContext(context));
      return components.toString();
    } catch (err) {
      console.error('Error applying decipher:', err);
      return args.url;
    }
  };

  const nTransform = url => {
    try {
      const components = new URL(decodeURIComponent(url));
      const n = components.searchParams.get('n');

      if (!n || !nTransformScript) return url;

      const context = {};
      context[N_ARGUMENT] = n;
      nTransformScript.code = policy.createScript(nTransformScript.code);
      const transformedN = nTransformScript.runInNewContext(context);

      if (transformedN) {
        if (n === transformedN) {
          console.warn('Transformed n parameter is the same as input, n function possibly short-circuited');
        } else if (transformedN.startsWith('enhanced_except_') || transformedN.endsWith(`_w8_${n}`)) {
          console.warn('N function did not complete due to exception');
        }

        components.searchParams.set('n', transformedN);
      } else {
        console.warn('Transformed n parameter is null, n function possibly faulty');
      }

      return components.toString();
    } catch (err) {
      console.error('Error applying n transform:', err);
      return url;
    }
  };

  const cipher = !format.url;
  const url = format.url || format.signatureCipher || format.cipher;

  if (!url) return;

  try {
    format.url = nTransform(cipher ? decipher(url) : url);

    delete format.signatureCipher;
    delete format.cipher;
  } catch (err) {
    console.error('Error setting download URL:', err);
  }
};

exports.decipherFormats = async(formats, html5player, options) => {
  try {
    const decipheredFormats = {};
    const [decipherScript, nTransformScript] = await exports.getFunctions(html5player, options);

    formats.forEach(format => {
      exports.setDownloadURL(format, decipherScript, nTransformScript);
      if (format.url) {
        decipheredFormats[format.url] = format;
      }
    });

    return decipheredFormats;
  } catch (err) {
    console.error('Error deciphering formats:', err);
    return {};
  }
};

const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync('background.js', 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) {
    throw new Error(`missing function ${name}`);
  }

  const paramsStart = source.indexOf('(', start);
  let paramsDepth = 0;
  let paramsEnd = paramsStart;
  for (; paramsEnd < source.length; paramsEnd += 1) {
    const ch = source[paramsEnd];
    if (ch === '(') paramsDepth += 1;
    if (ch === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        break;
      }
    }
  }

  const braceStart = source.indexOf('{', paramsEnd);
  let depth = 0;
  let end = braceStart;
  for (; end < source.length; end += 1) {
    const ch = source[end];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }

  return source.slice(start, end);
}

const bundle = [
  'const AUTO_STEP_DELAY_MIN_ALLOWED_SECONDS = 0;',
  'const AUTO_STEP_DELAY_MAX_ALLOWED_SECONDS = 600;',
  'const PERSISTED_SETTING_DEFAULTS = { autoStepDelaySeconds: null };',
  extractFunction('normalizeAutoStepDelaySeconds'),
  extractFunction('resolveLegacyAutoStepDelaySeconds'),
].join('\n');

const api = new Function(`${bundle}; return { normalizeAutoStepDelaySeconds, resolveLegacyAutoStepDelaySeconds };`)();

assert.strictEqual(
  api.normalizeAutoStepDelaySeconds(''),
  null,
  'empty input should remain empty instead of being forced to a default delay'
);

assert.strictEqual(
  api.normalizeAutoStepDelaySeconds(null, null),
  null,
  'null input should stay null'
);

assert.strictEqual(
  api.normalizeAutoStepDelaySeconds('0'),
  0,
  'zero seconds should be kept so the UI can explicitly show no extra delay'
);

assert.strictEqual(
  api.normalizeAutoStepDelaySeconds('12.9'),
  12,
  'delay seconds should be floored to an integer'
);

assert.strictEqual(
  api.normalizeAutoStepDelaySeconds('-50'),
  0,
  'negative delay should clamp to zero seconds'
);

assert.strictEqual(
  api.normalizeAutoStepDelaySeconds('999'),
  600,
  'delay should clamp to the configured upper bound'
);

assert.strictEqual(
  api.resolveLegacyAutoStepDelaySeconds({}),
  undefined,
  'missing legacy fields should not synthesize a migrated delay'
);

assert.strictEqual(
  api.resolveLegacyAutoStepDelaySeconds({ autoStepRandomDelayMinSeconds: 12 }),
  12,
  'legacy min-only settings should migrate to that same delay'
);

assert.strictEqual(
  api.resolveLegacyAutoStepDelaySeconds({ autoStepRandomDelayMaxSeconds: 18 }),
  18,
  'legacy max-only settings should migrate to that same delay'
);

assert.strictEqual(
  api.resolveLegacyAutoStepDelaySeconds({
    autoStepRandomDelayMinSeconds: 12,
    autoStepRandomDelayMaxSeconds: 18,
  }),
  15,
  'legacy min/max ranges should migrate to their rounded midpoint'
);

assert.strictEqual(
  api.resolveLegacyAutoStepDelaySeconds({
    autoStepRandomDelayMinSeconds: '',
    autoStepRandomDelayMaxSeconds: '',
  }),
  null,
  'empty legacy settings should migrate to no delay'
);

const customEmailBundle = [
  extractFunction('normalizeMailProvider'),
  extractFunction('normalizeRegistrationMode'),
  extractFunction('normalizeEmailGenerator'),
  extractFunction('normalizeCustomEmailSuffix'),
  extractFunction('isGeneratedAliasProvider'),
  extractFunction('isCustomAliasMode'),
  extractFunction('shouldUseCustomRegistrationEmail'),
  extractFunction('didMailProviderChange'),
  extractFunction('getRegistrationRestartAnchorStep'),
  extractFunction('generateRandomSuffix'),
  extractFunction('doesCustomAliasEmailMatchTemplate'),
  extractFunction('buildGeneratedAliasEmail'),
].join('\n');

const customEmailApi = new Function(`
let randomValue = 0;
const HOTMAIL_PROVIDER = 'hotmail-api';
const REGISTRATION_MODE_OAUTH = 'oauth';
const REGISTRATION_MODE_GPT = 'gpt';
const PERSISTED_SETTING_DEFAULTS = { mailProvider: '163' };
const nativeMath = globalThis.Math;
const Math = {
  floor(value) {
    return nativeMath.floor(value);
  },
  random() {
    return randomValue;
  },
};

function isHotmailProvider(state = {}) {
  return String(state?.mailProvider || '').trim().toLowerCase() === 'hotmail-api';
}

${customEmailBundle}

return {
  setRandom(value) {
    randomValue = value;
  },
  normalizeCustomEmailSuffix,
  shouldUseCustomRegistrationEmail,
  didMailProviderChange,
  getRegistrationRestartAnchorStep,
  doesCustomAliasEmailMatchTemplate,
  buildGeneratedAliasEmail,
};
`)();

assert.strictEqual(
  customEmailApi.normalizeCustomEmailSuffix('aleeas.com'),
  '@aleeas.com',
  '自定义邮箱后缀应自动补齐 @ 前缀'
);

assert.strictEqual(
  customEmailApi.normalizeCustomEmailSuffix('@Aleeas.com'),
  '@aleeas.com',
  '自定义邮箱后缀应归一化，避免大小写和多余 @ 干扰模板匹配'
);

assert.strictEqual(
  customEmailApi.shouldUseCustomRegistrationEmail({
    mailProvider: 'qq',
    emailGenerator: 'custom',
    customEmailAliasMode: false,
  }),
  true,
  '自定义完整邮箱模式下，Auto 仍应等待用户手填完整注册邮箱'
);

assert.strictEqual(
  customEmailApi.shouldUseCustomRegistrationEmail({
    mailProvider: 'qq',
    emailGenerator: 'custom',
    customEmailAliasMode: true,
  }),
  false,
  '自定义别名模式下，Auto 不应再停在等待手填邮箱'
);

assert.strictEqual(
  customEmailApi.doesCustomAliasEmailMatchTemplate({
    mailProvider: '2925',
    emailGenerator: 'custom',
    customEmailAliasMode: true,
    emailPrefix: 'xuemk2025',
    emailSuffix: '@aleeas.com',
  }, 'xuemk2025abc@aleeas.com'),
  false,
  '2925 模式下即使残留自定义别名配置，也不应再被视为自定义后缀模式'
);

assert.strictEqual(
  customEmailApi.didMailProviderChange(
    { mailProvider: 'qq' },
    { mailProvider: '2925' }
  ),
  true,
  '邮箱服务切换到 2925 时应触发注册链路初始化'
);

assert.strictEqual(
  customEmailApi.didMailProviderChange(
    { mailProvider: '2925' },
    { mailProvider: '2925' }
  ),
  false,
  '邮箱服务未变化时不应误判为需要初始化'
);

assert.strictEqual(
  customEmailApi.getRegistrationRestartAnchorStep({ registrationMode: 'gpt' }),
  'A2',
  'GPT 注册模式切换邮箱服务后应从 A2 重新开始'
);

assert.strictEqual(
  customEmailApi.getRegistrationRestartAnchorStep({ registrationMode: 'oauth' }),
  '3',
  'OAuth 注册模式切换邮箱服务后应从步骤 3 重新开始'
);

customEmailApi.setRandom(0);
const customAliasEmail = customEmailApi.buildGeneratedAliasEmail({
  mailProvider: 'qq',
  emailGenerator: 'custom',
  customEmailAliasMode: true,
  emailPrefix: 'aleeas2026+',
  emailSuffix: 'aleeas.com',
});

assert.strictEqual(
  customAliasEmail,
  'aleeas2026+aaa@aleeas.com',
  '自定义别名模式应生成 prefix + random(3~10) + suffix 结构的邮箱'
);

assert.strictEqual(
  customEmailApi.doesCustomAliasEmailMatchTemplate({
    emailGenerator: 'custom',
    customEmailAliasMode: true,
    emailPrefix: 'aleeas2026+',
    emailSuffix: '@aleeas.com',
  }, customAliasEmail),
  true,
  '已生成的自定义别名邮箱应能被模板匹配函数识别'
);

assert.strictEqual(
  customEmailApi.doesCustomAliasEmailMatchTemplate({
    emailGenerator: 'custom',
    customEmailAliasMode: true,
    emailPrefix: 'aleeas2026+',
    emailSuffix: '@aleeas.com',
  }, 'aleeas2026+aa@aleeas.com'),
  false,
  '随机段不足 3 位时不应被视为有效别名邮箱'
);

const mail2925Email = customEmailApi.buildGeneratedAliasEmail({
  mailProvider: '2925',
  emailPrefix: 'demo',
});

assert.strictEqual(
  mail2925Email,
  'demoaaaaaa@2925.com',
  '旧的 2925 别名生成逻辑应保持不变'
);

const mail2925EmailWithStaleCustomSuffix = customEmailApi.buildGeneratedAliasEmail({
  mailProvider: '2925',
  emailGenerator: 'custom',
  customEmailAliasMode: true,
  emailPrefix: 'xuemk2025',
  emailSuffix: '@aleeas.com',
});

assert.strictEqual(
  mail2925EmailWithStaleCustomSuffix,
  'xuemk2025aaaaaa@2925.com',
  '切到 2925 后即使残留自定义邮箱后缀，也必须优先使用 2925 的服务后缀'
);

console.log('auto step delay and custom email helper tests passed');

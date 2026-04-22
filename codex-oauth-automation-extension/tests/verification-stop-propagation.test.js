const assert = require('assert');
const fs = require('fs');

const backgroundSource = fs.readFileSync('background.js', 'utf8');
const signupPageSource = fs.readFileSync('content/signup-page.js', 'utf8');
const mail2925Source = fs.readFileSync('content/mail-2925.js', 'utf8');

function extractFunctionFromSource(sourceText, name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers
    .map(marker => sourceText.indexOf(marker))
    .find(index => index >= 0);
  if (start < 0) {
    throw new Error(`missing function ${name}`);
  }

  let parenDepth = 0;
  let signatureEnded = false;
  let braceStart = -1;
  for (let i = start; i < sourceText.length; i += 1) {
    const ch = sourceText[i];
    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        signatureEnded = true;
      }
    } else if (ch === '{' && signatureEnded) {
      braceStart = i;
      break;
    }
  }
  if (braceStart < 0) {
    throw new Error(`missing body for function ${name}`);
  }

  let depth = 0;
  let end = braceStart;
  for (; end < sourceText.length; end += 1) {
    const ch = sourceText[end];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }

  return sourceText.slice(start, end);
}

function extractFunction(name) {
  return extractFunctionFromSource(backgroundSource, name);
}

function extractSignupPageFunction(name) {
  return extractFunctionFromSource(signupPageSource, name);
}

function extractMail2925Function(name) {
  return extractFunctionFromSource(mail2925Source, name);
}

async function testPollFreshVerificationCodeRethrowsStop() {
  const bundle = [
    extractFunction('isStopError'),
    extractFunction('throwIfStopped'),
    extractFunction('pollFreshVerificationCode'),
  ].join('\n');

  const api = new Function(`
let stopRequested = false;
const STOP_ERROR_MESSAGE = '流程已被用户停止。';
const HOTMAIL_PROVIDER = 'hotmail-api';
const VERIFICATION_POLL_MAX_ROUNDS = 5;
const logs = [];
let resendCalls = 0;

function getHotmailVerificationPollConfig() {
  return {};
}
async function pollHotmailVerificationCode() {
  throw new Error('hotmail path should not run in this test');
}
function getVerificationCodeStateKey(step) {
  return step === 4 ? 'lastSignupCode' : 'lastLoginCode';
}
function getVerificationPollPayload(step, state, overrides = {}) {
  return {
    filterAfterTimestamp: 123,
    ...overrides,
  };
}
async function sendToMailContentScriptResilient() {
  throw new Error(STOP_ERROR_MESSAGE);
}
async function requestVerificationCodeResend() {
  resendCalls += 1;
}
async function addLog(message, level) {
  logs.push({ message, level });
}
async function getTabId() {
  return null;
}
const chrome = { tabs: { update: async () => {} } };

${bundle}

return {
  pollFreshVerificationCode,
  snapshot() {
    return { logs, resendCalls };
  },
};
`)();

  let error = null;
  try {
    await api.pollFreshVerificationCode(7, {}, { provider: 'qq' }, {});
  } catch (err) {
    error = err;
  }

  const state = api.snapshot();
  assert.strictEqual(error?.message, '流程已被用户停止。', 'Stop 错误应原样向上抛出');
  assert.strictEqual(state.resendCalls, 0, 'Stop 后不应继续请求新的验证码');
  assert.deepStrictEqual(state.logs, [], 'Stop 后不应再记录普通失败或重试日志');
}

async function testResolveVerificationStepRethrowsStopFromFreshRequest() {
  const bundle = [
    extractFunction('isStopError'),
    extractFunction('normalizeVerificationCodeRetryCount'),
    extractFunction('getVerificationCodeRetryConfig'),
    extractFunction('resolveVerificationStep'),
  ].join('\n');

  const api = new Function(`
const STOP_ERROR_MESSAGE = '流程已被用户停止。';
const HOTMAIL_PROVIDER = 'hotmail-api';
const PERSISTED_SETTING_DEFAULTS = { verificationCodeRetryCount: 1 };
const logs = [];
let pollCalls = 0;

function isSignupVerificationStep(step) {
  return step === 4 || step === '4' || step === 'A4';
}
function isLoginVerificationStep(step) {
  return step === 7 || step === '7';
}
function throwIfStopped() {}
function getVerificationCodeStateKey(step) {
  return step === 4 ? 'lastSignupCode' : 'lastLoginCode';
}
function getHotmailVerificationPollConfig() {
  return {};
}
function getVerificationCodeLabel(step) {
  return step === 4 ? '注册' : '登录';
}
function isRestartCurrentAttemptError() {
  return false;
}
function isStep7RestartFromStep6Error() {
  return false;
}
async function requestVerificationCodeResend() {
  throw new Error(STOP_ERROR_MESSAGE);
}
async function addLog(message, level) {
  logs.push({ message, level });
}
async function pollFreshVerificationCode() {
  pollCalls += 1;
  return { code: '123456', emailTimestamp: Date.now() };
}
async function submitVerificationCode() {
  throw new Error('submit should not run in this test');
}
async function setState() {}
async function completeStepFromBackground() {}

${bundle}

return {
  resolveVerificationStep,
  snapshot() {
    return { logs, pollCalls };
  },
};
`)();

  let error = null;
  try {
    await api.resolveVerificationStep(7, {}, { provider: 'qq' }, { requestFreshCodeFirst: true });
  } catch (err) {
    error = err;
  }

  const state = api.snapshot();
  assert.strictEqual(error?.message, '流程已被用户停止。', '首次请求新验证码收到 Stop 后应立即终止');
  assert.strictEqual(state.pollCalls, 0, 'Stop 后不应继续进入邮箱轮询');
  assert.deepStrictEqual(state.logs, [], 'Stop 后不应追加降级日志');
}

async function testResolveVerificationStepRetriesConfiguredPollRoundsBeforeSuccess() {
  const bundle = [
    extractFunction('isStopError'),
    extractFunction('getErrorMessage'),
    extractFunction('isVerificationMailPollingError'),
    extractFunction('normalizeVerificationCodeRetryCount'),
    extractFunction('getVerificationCodeRetryConfig'),
    extractFunction('resolveVerificationStep'),
  ].join('\n');

  const api = new Function(`
const STOP_ERROR_MESSAGE = '流程已被用户停止。';
const HOTMAIL_PROVIDER = 'hotmail-api';
const PERSISTED_SETTING_DEFAULTS = { verificationCodeRetryCount: 1 };
const logs = [];
const stateUpdates = [];
const completions = [];
let pollCalls = 0;
let submitCalls = 0;

function isSignupVerificationStep(step) {
  return step === 4 || step === '4' || step === 'A4';
}
function isLoginVerificationStep(step) {
  return step === 7 || step === '7';
}
function throwIfStopped() {}
function getVerificationCodeStateKey(step) {
  return step === 7 ? 'lastLoginCode' : 'lastSignupCode';
}
function getHotmailVerificationPollConfig() {
  return {};
}
function getVerificationCodeLabel(step) {
  return step === 7 ? '登录' : '注册';
}
function isRestartCurrentAttemptError() {
  return false;
}
function isStep7RestartFromStep6Error() {
  return false;
}
async function requestVerificationCodeResend() {
  throw new Error('requestVerificationCodeResend should not run in this test');
}
async function addLog(message, level) {
  logs.push({ message, level });
}
async function pollFreshVerificationCode() {
  pollCalls += 1;
  if (pollCalls < 3) {
    throw new Error('步骤 4：邮箱轮询结束，但未获取到验证码。');
  }
  return {
    code: '654321',
    emailTimestamp: 1700000000000 + pollCalls,
  };
}
async function submitVerificationCode() {
  submitCalls += 1;
  return { success: true };
}
async function setState(payload) {
  stateUpdates.push(payload);
}
async function completeStepFromBackground(step, payload) {
  completions.push({ step, payload });
}

${bundle}

return {
  resolveVerificationStep,
  snapshot() {
    return { logs, pollCalls, submitCalls, stateUpdates, completions };
  },
};
`)();

  await api.resolveVerificationStep(
    4,
    { verificationCodeRetryEnabled: true, verificationCodeRetryCount: 3 },
    { provider: 'qq' },
    { requestFreshCodeFirst: false }
  );

  const state = api.snapshot();
  assert.strictEqual(state.pollCalls, 3, '启用后应在同一步内继续执行配置的外层收码轮次');
  assert.strictEqual(state.submitCalls, 1, '命中验证码后仍应只提交一次');
  assert.strictEqual(state.completions.length, 1, '后续轮次命中验证码后应正常完成步骤');
  assert.strictEqual(state.stateUpdates[0]?.lastSignupCode, '654321', '应写回最终命中的注册验证码');
  assert.strictEqual(
    state.logs.some((entry) => /继续执行配置的重轮询（2\/3）/.test(entry.message)),
    true,
    '第一次外层轮询失败后应进入第 2/3 轮'
  );
  assert.strictEqual(
    state.logs.some((entry) => /继续执行配置的重轮询（3\/3）/.test(entry.message)),
    true,
    '第二次外层轮询失败后应进入第 3/3 轮'
  );
}

async function testResolveVerificationStepFailsAfterConfiguredPollRoundsForLoginCode() {
  const bundle = [
    extractFunction('isStopError'),
    extractFunction('getErrorMessage'),
    extractFunction('isVerificationMailPollingError'),
    extractFunction('normalizeVerificationCodeRetryCount'),
    extractFunction('getVerificationCodeRetryConfig'),
    extractFunction('resolveVerificationStep'),
  ].join('\n');

  const api = new Function(`
const STOP_ERROR_MESSAGE = '流程已被用户停止。';
const HOTMAIL_PROVIDER = 'hotmail-api';
const PERSISTED_SETTING_DEFAULTS = { verificationCodeRetryCount: 1 };
const logs = [];
let pollCalls = 0;

function isSignupVerificationStep(step) {
  return step === 4 || step === '4' || step === 'A4';
}
function isLoginVerificationStep(step) {
  return step === 7 || step === '7';
}
function throwIfStopped() {}
function getVerificationCodeStateKey(step) {
  return step === 7 ? 'lastLoginCode' : 'lastSignupCode';
}
function getHotmailVerificationPollConfig() {
  return {};
}
function getVerificationCodeLabel(step) {
  return step === 7 ? '登录' : '注册';
}
function isRestartCurrentAttemptError() {
  return false;
}
function isStep7RestartFromStep6Error() {
  return false;
}
async function requestVerificationCodeResend() {
  throw new Error('requestVerificationCodeResend should not run in this test');
}
async function addLog(message, level) {
  logs.push({ message, level });
}
async function pollFreshVerificationCode() {
  pollCalls += 1;
  throw new Error('步骤 7：邮箱轮询结束，但未获取到验证码。');
}
async function submitVerificationCode() {
  throw new Error('submitVerificationCode should not run in this test');
}
async function setState() {}
async function completeStepFromBackground() {}

${bundle}

return {
  resolveVerificationStep,
  snapshot() {
    return { logs, pollCalls };
  },
};
`)();

  let error = null;
  try {
    await api.resolveVerificationStep(
      7,
      { verificationCodeRetryEnabled: true, verificationCodeRetryCount: 2 },
      { provider: 'qq' },
      { requestFreshCodeFirst: false }
    );
  } catch (err) {
    error = err;
  }

  const state = api.snapshot();
  assert.strictEqual(error?.message, '步骤 7：邮箱轮询结束，但未获取到验证码。', '达到配置轮次后应沿用原始失败原因');
  assert.strictEqual(state.pollCalls, 2, '登录验证码步骤也应共用同一套外层收码轮次配置');
  assert.strictEqual(
    state.logs.some((entry) => /继续执行配置的重轮询（2\/2）/.test(entry.message)),
    true,
    '达到上限前应记录将进入最后一轮重轮询'
  );
}

async function testResolveVerificationStepKeepsSinglePollWhenRetryDisabled() {
  const bundle = [
    extractFunction('isStopError'),
    extractFunction('getErrorMessage'),
    extractFunction('isVerificationMailPollingError'),
    extractFunction('normalizeVerificationCodeRetryCount'),
    extractFunction('getVerificationCodeRetryConfig'),
    extractFunction('resolveVerificationStep'),
  ].join('\n');

  const api = new Function(`
const STOP_ERROR_MESSAGE = '流程已被用户停止。';
const HOTMAIL_PROVIDER = 'hotmail-api';
const PERSISTED_SETTING_DEFAULTS = { verificationCodeRetryCount: 1 };
let pollCalls = 0;

function isSignupVerificationStep(step) {
  return step === 4 || step === '4' || step === 'A4';
}
function isLoginVerificationStep(step) {
  return step === 7 || step === '7';
}
function throwIfStopped() {}
function getVerificationCodeStateKey(step) {
  return step === 7 ? 'lastLoginCode' : 'lastSignupCode';
}
function getHotmailVerificationPollConfig() {
  return {};
}
function getVerificationCodeLabel(step) {
  return step === 7 ? '登录' : '注册';
}
function isRestartCurrentAttemptError() {
  return false;
}
function isStep7RestartFromStep6Error() {
  return false;
}
async function requestVerificationCodeResend() {
  throw new Error('requestVerificationCodeResend should not run in this test');
}
async function addLog() {}
async function pollFreshVerificationCode() {
  pollCalls += 1;
  throw new Error('步骤 4：邮箱轮询结束，但未获取到验证码。');
}
async function submitVerificationCode() {
  throw new Error('submitVerificationCode should not run in this test');
}
async function setState() {}
async function completeStepFromBackground() {}

${bundle}

return {
  resolveVerificationStep,
  snapshot() {
    return { pollCalls };
  },
};
`)();

  let error = null;
  try {
    await api.resolveVerificationStep(
      4,
      { verificationCodeRetryEnabled: false, verificationCodeRetryCount: 5 },
      { provider: 'qq' },
      { requestFreshCodeFirst: false }
    );
  } catch (err) {
    error = err;
  }

  const state = api.snapshot();
  assert.strictEqual(error?.message, '步骤 4：邮箱轮询结束，但未获取到验证码。', '关闭后应保持原始失败行为');
  assert.strictEqual(state.pollCalls, 1, '关闭后不应增加额外的外层收码轮次');
}

async function testWaitForVerificationSubmitOutcomeReturnsRestartCurrentAttempt() {
  const bundle = [
    extractSignupPageFunction('normalizeFlowStep'),
    extractSignupPageFunction('isSignupVerificationFlowStep'),
    extractSignupPageFunction('isLoginVerificationFlowStep'),
    extractSignupPageFunction('waitForVerificationSubmitOutcome'),
  ].join('\n');

  const api = new Function(`
let currentTime = 0;
let sleepCalls = 0;
const Date = {
  now() {
    return currentTime;
  },
};

function throwIfStopped() {}
function getVerificationErrorText() {
  return '';
}
function getStep7RestartCurrentAttemptSignal() {
  if (currentTime < 300) {
    return null;
  }
  return {
    restartCurrentAttempt: true,
    error: 'STEP7_RESTART_CURRENT_ATTEMPT::max_check_attempts_error_page::https://auth.openai.com/log-in',
  };
}
function getStep7RestartFromStep6Signal() {
  return null;
}
function isStep5Ready() {
  return false;
}
function isStep8Ready() {
  return false;
}
function isAddPhonePageReady() {
  return false;
}
function isVerificationPageStillVisible() {
  return false;
}
async function sleep(ms) {
  sleepCalls += 1;
  currentTime += ms;
}

${bundle}

return {
  waitForVerificationSubmitOutcome,
  snapshot() {
    return { currentTime, sleepCalls };
  },
};
`)();

  const outcome = await api.waitForVerificationSubmitOutcome(7, 300);
  const state = api.snapshot();

  assert.strictEqual(outcome.restartCurrentAttempt, true, '步骤 7 命中 max_check_attempts 错误页时应返回整轮重开信号');
  assert.match(outcome.error, /max_check_attempts/, '返回结果应保留 max_check_attempts marker');
  assert.strictEqual(state.currentTime, 300, '应在超时边界复查错误页，而不是直接按成功推定');
  assert.strictEqual(state.sleepCalls, 2, '应等待到超时边界后再做最终复查');
}

async function testWaitForSignupEmailInputOrLaterStateRecognizesAdvancedVerificationPage() {
  const bundle = [
    extractSignupPageFunction('isSignupStatePastEmailStep'),
    extractSignupPageFunction('waitForSignupEmailInputOrLaterState'),
  ].join('\n');

  const api = new Function(`
let currentTime = 0;
let sleepCalls = 0;
const Date = {
  now() {
    return currentTime;
  },
};

function throwIfStopped() {}
function getVisibleAuthEmailInput() {
  return null;
}
function inspectSignupVerificationState() {
  if (currentTime < 300) {
    return { state: 'unknown' };
  }
  return { state: 'verification' };
}
async function sleep(ms) {
  sleepCalls += 1;
  currentTime += ms;
}

${bundle}

return {
  waitForSignupEmailInputOrLaterState,
  snapshot() {
    return { currentTime, sleepCalls };
  },
};
`)();

  const result = await api.waitForSignupEmailInputOrLaterState(600);
  const state = api.snapshot();

  assert.strictEqual(result.state, 'verification', 'A2 等待期间若页面已进入验证码页，应直接识别为已越过邮箱页');
  assert.strictEqual(state.currentTime, 300, '应轮询到验证码页出现为止');
  assert.strictEqual(state.sleepCalls, 2, '应在页面切换期内继续轮询，而不是直接失败');
}

async function testWaitForSignupPasswordInputOrLaterStateRecognizesAdvancedVerificationPage() {
  const bundle = [
    extractSignupPageFunction('isSignupStatePastPasswordStep'),
    extractSignupPageFunction('waitForSignupPasswordInputOrLaterState'),
  ].join('\n');

  const api = new Function(`
let currentTime = 0;
let sleepCalls = 0;
const Date = {
  now() {
    return currentTime;
  },
};

function throwIfStopped() {}
function getVisibleAuthPasswordInput() {
  return null;
}
function getSignupPasswordSubmitButton() {
  return null;
}
function inspectSignupVerificationState() {
  if (currentTime < 300) {
    return { state: 'unknown' };
  }
  return { state: 'verification' };
}
async function sleep(ms) {
  sleepCalls += 1;
  currentTime += ms;
}

${bundle}

return {
  waitForSignupPasswordInputOrLaterState,
  snapshot() {
    return { currentTime, sleepCalls };
  },
};
`)();

  const result = await api.waitForSignupPasswordInputOrLaterState(600);
  const state = api.snapshot();

  assert.strictEqual(result.state, 'verification', 'A3 等待期间若页面已进入验证码页，应直接识别为已越过密码页');
  assert.strictEqual(state.currentTime, 300, '应轮询到验证码页出现为止');
  assert.strictEqual(state.sleepCalls, 2, '应在页面切换期内继续轮询，而不是直接失败');
}

async function testExecuteStepA3ReusesExistingSignupEmail() {
  const bundle = [
    extractFunction('executeStepA3'),
  ].join('\n');

  const api = new Function(`
let resolveCalls = 0;
const sentMessages = [];
const passwordCalls = [];

async function getState() {
  return {
    email: 'xuemk2027dc49kg@2925.com',
    customPassword: 'Passw0rd!12345',
  };
}
async function resolveRegistrationEmail() {
  resolveCalls += 1;
  return 'xuemk2027muexqx@2925.com';
}
async function prepareRegistrationPassword(state, resolvedEmail, stepLabel) {
  passwordCalls.push({ state, resolvedEmail, stepLabel });
  return 'Passw0rd!12345';
}
async function sendToContentScript(target, payload) {
  sentMessages.push({ target, payload });
}

${bundle}

return {
  executeStepA3,
  snapshot() {
    return { resolveCalls, sentMessages, passwordCalls };
  },
};
`)();

  await api.executeStepA3({
    email: 'old-value@2925.com',
  });

  const state = api.snapshot();
  assert.strictEqual(state.resolveCalls, 0, 'A3 在已有本轮注册邮箱时不应再次生成新邮箱');
  assert.strictEqual(state.passwordCalls.length, 1, 'A3 应继续正常准备密码');
  assert.strictEqual(
    state.passwordCalls[0].resolvedEmail,
    'xuemk2027dc49kg@2925.com',
    'A3 应复用 A2 已确定的注册邮箱'
  );
  assert.deepStrictEqual(
    state.sentMessages,
    [
      {
        target: 'signup-page',
        payload: {
          type: 'EXECUTE_STEP',
          step: 'A3',
          source: 'background',
          payload: { password: 'Passw0rd!12345' },
        },
      },
    ],
    'A3 发送给内容脚本的负载应只包含密码，邮箱应由后台状态保持一致'
  );
}

async function testIsPostSignupSuccessPageAcceptsChatGptLandingWhenWindowStateAffectsVisibility() {
  const bundle = [
    extractSignupPageFunction('isChatGptAppLandingPage'),
    extractSignupPageFunction('isPostSignupSuccessPage'),
  ].join('\n');

  const api = new Function(`
const location = {
  hostname: 'chatgpt.com',
  pathname: '/',
};

function hasExitedStep5Form() {
  return true;
}
function getPageTextSnapshot() {
  return 'ChatGPT 可以帮助你写作 编程 总结 更多内容';
}
function isAddPhonePageReady() {
  return false;
}
function isStep8Ready() {
  return false;
}
function isPostSignupOnboardingPage() {
  return false;
}

${bundle}

return {
  isChatGptAppLandingPage,
  isPostSignupSuccessPage,
};
`)();

  assert.strictEqual(
    api.isChatGptAppLandingPage(),
    true,
    'chatgpt.com 落地页在已离开 step5 form 后应被识别为成功落地页'
  );
  assert.strictEqual(
    api.isPostSignupSuccessPage(),
    true,
    '即使窗口状态影响可见元素判断，A5 READY 重放到 chatgpt.com 落地页也应直接按成功处理'
  );
}

async function testIsPostSignupSuccessPageFallsBackToChatGptUrlOnly() {
  const bundle = [
    extractSignupPageFunction('isChatGptAppLandingPage'),
    extractSignupPageFunction('isPostSignupSuccessPage'),
  ].join('\n');

  const api = new Function(`
const location = {
  hostname: 'chatgpt.com',
  pathname: '/',
};

function hasExitedStep5Form() {
  return false;
}
function getPageTextSnapshot() {
  return '';
}
function isAddPhonePageReady() {
  return false;
}
function isStep8Ready() {
  return false;
}
function isPostSignupOnboardingPage() {
  return false;
}

${bundle}

return {
  isChatGptAppLandingPage,
  isPostSignupSuccessPage,
};
`)();

  assert.strictEqual(
    api.isChatGptAppLandingPage(),
    true,
    '只要 URL 已跳到非 auth 的 chatgpt.com，就应触发第 5 步成功兜底'
  );
  assert.strictEqual(
    api.isPostSignupSuccessPage(),
    true,
    '第 5 步成功页判断应接受纯 URL 兜底，不再依赖表单退出状态或页面文案'
  );
}

async function testMail2925SeenMailKeyIncludesMailContentBeyondItemId() {
  const bundle = [
    extractMail2925Function('normalizeMailIdentityPart'),
    extractMail2925Function('buildSeenMailKey'),
  ].join('\n');

  const api = new Function(`
${bundle}

return {
  buildSeenMailKey,
};
`)();

  const firstKey = api.buildSeenMailKey({
    itemId: 'row-1',
    itemTimestamp: 1710000000000,
    text: '你的 ChatGPT 代码为 123456',
    code: '123456',
  });
  const secondKey = api.buildSeenMailKey({
    itemId: 'row-1',
    itemTimestamp: 1710000060000,
    text: '你的 ChatGPT 代码为 654321',
    code: '654321',
  });

  assert.notStrictEqual(
    firstKey,
    secondKey,
    '2925 邮箱即使复用了同一个 itemId，只要新邮件时间或验证码变化，就不应被视为同一封已处理邮件'
  );
}

async function testMail2925TimeWindowAllowsUnparseableFreshMailInA4Recovery() {
  const bundle = [
    extractMail2925Function('findMailItems'),
    extractMail2925Function('normalizeMailIdentityPart'),
    extractMail2925Function('getMailItemText'),
    extractMail2925Function('getMailItemTimeText'),
    extractMail2925Function('getMailItemId'),
    extractMail2925Function('getCurrentMailIds'),
    extractMail2925Function('buildSeenMailKey'),
    extractMail2925Function('normalizeMinuteTimestamp'),
    extractMail2925Function('resolveMailTimeWindowState'),
    extractMail2925Function('matchesMailFilters'),
    extractMail2925Function('looksLikeChatGptVerificationMail'),
    extractMail2925Function('extractVerificationCode'),
    extractMail2925Function('extractEmails'),
    extractMail2925Function('emailMatchesTarget'),
    extractMail2925Function('getTargetEmailMatchState'),
    extractMail2925Function('parseMailItemTimestamp'),
    extractMail2925Function('waitForMailItems'),
    extractMail2925Function('ensureInboxListReady'),
    extractMail2925Function('refreshInbox'),
    extractMail2925Function('handlePollEmail'),
  ].join('\n');

const api = new Function(`
let seenMailKeys = new Set();
const logs = [];
let opened = false;
const MAIL_ITEM_SELECTORS = ['.mail-item'];
const previewNode = {
  textContent: '',
  dataset: {
    preview: 'Your ChatGPT code is 654321 and was sent to demo123@2925.com',
  },
  getAttribute(name) {
    return name === 'data-preview' ? this.dataset.preview : '';
  },
};

const fakeItem = {
  dataset: { id: 'mail-1' },
  textContent: 'OpenAI 发件人 noreply@tm.openai.com 验证邮件',
  querySelector(selector) {
    if (selector === '.mail-content-title') {
      return {
        getAttribute(name) {
          return name === 'title' ? 'OpenAI 发件人 noreply@tm.openai.com 验证邮件' : '';
        },
        textContent: 'OpenAI 发件人 noreply@tm.openai.com 验证邮件',
      };
    }
    if (selector === '.mail-content-text') {
      return { textContent: '请查看邮件正文' };
    }
    return null;
  },
  querySelectorAll(selector) {
    if (selector.includes('[data-preview]')) {
      return [previewNode];
    }
    return [];
  },
  getAttribute(name) {
    return name === 'data-id' ? 'mail-1' : '';
  },
};

const document = {
  querySelectorAll() {
    return [fakeItem];
  },
  querySelector() {
    return null;
  },
};

function log(message, level) {
  logs.push({ message, level });
}
async function persistSeenMailKeys() {}
async function sleep() {}
async function sleepRandom() {}
function simulateClick() {
  opened = true;
}

${bundle}

return {
  handlePollEmail,
  snapshot() {
    return { logs, opened, seenMailKeys: Array.from(seenMailKeys) };
  },
};
`)();

  const result = await api.handlePollEmail('A4', {
    senderFilters: ['openai', 'noreply', 'verify', 'auth'],
    subjectFilters: ['verify', 'verification', 'code', 'confirm'],
    maxAttempts: 1,
    intervalMs: 1000,
    filterAfterTimestamp: Date.now(),
    excludeCodes: [],
    strictChatGPTCodeOnly: false,
    targetEmail: 'demo123@2925.com',
  });
  const state = api.snapshot();

  assert.strictEqual(result.code, '654321', 'A4 恢复较慢时，即使时间文本无法解析，也应直接从列表元数据读出验证码');
  assert.strictEqual(state.opened, false, '2925 收码不应自动点开邮件正文');
}

async function testMail2925PreviewCodeWithoutExplicitTargetEmailStillAccepted() {
  const bundle = [
    extractMail2925Function('findMailItems'),
    extractMail2925Function('normalizeMailIdentityPart'),
    extractMail2925Function('getMailItemText'),
    extractMail2925Function('getMailItemTimeText'),
    extractMail2925Function('getMailItemId'),
    extractMail2925Function('getCurrentMailIds'),
    extractMail2925Function('buildSeenMailKey'),
    extractMail2925Function('normalizeMinuteTimestamp'),
    extractMail2925Function('resolveMailTimeWindowState'),
    extractMail2925Function('matchesMailFilters'),
    extractMail2925Function('looksLikeChatGptVerificationMail'),
    extractMail2925Function('extractVerificationCode'),
    extractMail2925Function('extractEmails'),
    extractMail2925Function('emailMatchesTarget'),
    extractMail2925Function('getTargetEmailMatchState'),
    extractMail2925Function('parseMailItemTimestamp'),
    extractMail2925Function('waitForMailItems'),
    extractMail2925Function('ensureInboxListReady'),
    extractMail2925Function('refreshInbox'),
    extractMail2925Function('handlePollEmail'),
  ].join('\n');

  const api = new Function(`
let seenMailKeys = new Set();
const logs = [];
const MAIL_ITEM_SELECTORS = ['.mail-item'];
const fakeItem = {
  dataset: { id: 'mail-openai-1' },
  textContent: 'bounces+20... 你的 ChatGPT 代码为 796665 你的 ChatGPT 代码为 796665',
  querySelector(selector) {
    if (selector === '.mail-content-title') {
      return {
        getAttribute(name) {
          return name === 'title' ? 'bounces+20... 你的 ChatGPT 代码为 796665' : '';
        },
        textContent: 'bounces+20... 你的 ChatGPT 代码为 796665',
      };
    }
    if (selector === '.mail-content-text') {
      return {
        textContent: '你的 ChatGPT 代码为 796665',
      };
    }
    if (selector.includes('time')) {
      return { textContent: '刚刚' };
    }
    return null;
  },
  querySelectorAll() {
    return [];
  },
  getAttribute(name) {
    return name === 'data-id' ? 'mail-openai-1' : '';
  },
};
const document = {
  querySelectorAll() {
    return [fakeItem];
  },
  querySelector() {
    return null;
  },
};
function log(message, level) {
  logs.push({ message, level });
}
async function persistSeenMailKeys() {}
async function sleep() {}
async function sleepRandom() {}
function simulateClick() {
  throw new Error('2925 预览验证码场景不应打开正文');
}

${bundle}

return {
  handlePollEmail,
  snapshot() {
    return { logs, seenMailKeys: Array.from(seenMailKeys) };
  },
};
`)();

  const result = await api.handlePollEmail('A4', {
    senderFilters: ['openai', 'noreply', 'verify', 'auth'],
    subjectFilters: ['verify', 'verification', 'code', 'confirm'],
    maxAttempts: 1,
    intervalMs: 1000,
    filterAfterTimestamp: Date.now(),
    excludeCodes: [],
    strictChatGPTCodeOnly: false,
    targetEmail: 'xuemk2027@2925.com',
  });
  const state = api.snapshot();

  assert.strictEqual(result.code, '796665', '列表已出现 ChatGPT 验证码时，即使发件人被截断且没有显式收件邮箱，也应直接采纳验证码');
  assert.strictEqual(state.seenMailKeys.length, 1, '成功识别后应记录已处理邮件键，避免重复消费');
}

async function testMail2925FallsBackToMailBodyWhenPreviewHasNoCode() {
  const bundle = [
    extractMail2925Function('findMailItems'),
    extractMail2925Function('normalizeMailIdentityPart'),
    extractMail2925Function('getMailItemText'),
    extractMail2925Function('getMailItemTimeText'),
    extractMail2925Function('getMailItemId'),
    extractMail2925Function('getCurrentMailIds'),
    extractMail2925Function('buildSeenMailKey'),
    extractMail2925Function('normalizeMinuteTimestamp'),
    extractMail2925Function('resolveMailTimeWindowState'),
    extractMail2925Function('matchesMailFilters'),
    extractMail2925Function('looksLikeChatGptVerificationMail'),
    extractMail2925Function('extractVerificationCode'),
    extractMail2925Function('extractEmails'),
    extractMail2925Function('emailMatchesTarget'),
    extractMail2925Function('getTargetEmailMatchState'),
    extractMail2925Function('parseMailItemTimestamp'),
    extractMail2925Function('waitForMailItems'),
    extractMail2925Function('ensureInboxListReady'),
    extractMail2925Function('refreshInbox'),
    extractMail2925Function('handlePollEmail'),
  ].join('\n');

  const api = new Function(`
let seenMailKeys = new Set();
const logs = [];
let opened = false;
const MAIL_ITEM_SELECTORS = ['.mail-item'];
const fakeItem = {
  dataset: { id: 'mail-detail-1' },
  textContent: 'OpenAI 你的临时 OpenAI 登录代码',
  querySelector(selector) {
    if (selector === '.mail-content-title') {
      return {
        getAttribute(name) {
          return name === 'title' ? 'OpenAI 你的临时 OpenAI 登录代码' : '';
        },
        textContent: 'OpenAI 你的临时 OpenAI 登录代码',
      };
    }
    if (selector === '.mail-content-text') {
      return { textContent: '请打开邮件正文查看验证码' };
    }
    if (selector.includes('time')) {
      return { textContent: '刚刚' };
    }
    return null;
  },
  querySelectorAll() {
    return [];
  },
  getAttribute(name) {
    return name === 'data-id' ? 'mail-detail-1' : '';
  },
};
const document = {
  body: {
    get textContent() {
      return opened
        ? 'Your ChatGPT code is 317221 and was sent to demo123@2925.com'
        : '列表页';
    },
  },
  querySelectorAll() {
    return [fakeItem];
  },
  querySelector() {
    return null;
  },
};
function log(message, level) {
  logs.push({ message, level });
}
async function persistSeenMailKeys() {}
async function sleep() {}
async function sleepRandom() {}
function simulateClick() {
  opened = true;
}

${bundle}

return {
  handlePollEmail,
  snapshot() {
    return { logs, opened, seenMailKeys: Array.from(seenMailKeys) };
  },
};
`)();

  const result = await api.handlePollEmail('A4', {
    senderFilters: ['openai', 'noreply', 'verify', 'auth'],
    subjectFilters: ['verify', 'verification', 'code', 'confirm'],
    maxAttempts: 1,
    intervalMs: 1000,
    filterAfterTimestamp: Date.now(),
    excludeCodes: [],
    strictChatGPTCodeOnly: false,
    targetEmail: 'demo123@2925.com',
  });
  const state = api.snapshot();

  assert.strictEqual(result.code, '317221', '当列表标题没有验证码时，应回退到邮件详情中读取验证码');
  assert.strictEqual(state.opened, true, '2925 在列表无验证码时应打开邮件详情查看正文');
  assert.strictEqual(state.seenMailKeys.length, 1, '正文验证码识别成功后也应记录已处理邮件键');
}

async function testMail2925EnsureInboxListReadyNavigatesBackFromReadMail() {
  const bundle = [
    extractMail2925Function('findMailItems'),
    extractMail2925Function('waitForMailItems'),
    extractMail2925Function('ensureInboxListReady'),
  ].join('\n');

  const api = new Function(`
let listVisible = false;
const MAIL_ITEM_SELECTORS = ['.mail-item'];
const logs = [];
const locationState = {
  href: 'https://2925.com/#/readMail/0/Inbox/unread/demo',
  _hash: '#/readMail/0/Inbox/unread/demo',
};
const location = {
  get href() {
    return locationState.href;
  },
  get hash() {
    return locationState._hash;
  },
  set hash(value) {
    locationState._hash = value;
    locationState.href = 'https://2925.com/' + value;
    if (value === '#/mailList') {
      listVisible = true;
    }
  },
};
const fakeItem = { textContent: 'mail row' };
const document = {
  querySelectorAll() {
    return listVisible ? [fakeItem] : [];
  },
  querySelector() {
    return null;
  },
};
function log(message, level) {
  logs.push({ message, level });
}
async function sleep() {}
async function sleepRandom() {}
function simulateClick() {}

${bundle}

return {
  ensureInboxListReady,
  snapshot() {
    return { href: location.href, logs, listVisible };
  },
};
`)();

  const items = await api.ensureInboxListReady('7');
  const state = api.snapshot();

  assert.strictEqual(items.length, 1, '停在 readMail 详情页时，应先切回 mailList 再继续找邮件列表');
  assert.strictEqual(state.href.endsWith('#/mailList'), true, '2925 详情页应强制切回收件箱列表路由');
}

async function testRequestVerificationCodeResendSwitchesToMail2925Tab() {
  const bundle = [
    extractFunction('requestVerificationCodeResend'),
  ].join('\n');

  const api = new Function(`
const updates = [];
const logs = [];
const stateUpdates = [];

function throwIfStopped() {}
async function getTabId(source) {
  if (source === 'signup-page') return 11;
  if (source === 'mail-2925') return 22;
  return null;
}
function getVerificationCodeLabel(step) {
  return step === 7 ? '登录' : '注册';
}
function isLoginVerificationStep(step) {
  return step === 7 || step === '7';
}
function getStep7RestartFromStep6Error() {
  return null;
}
function getRestartCurrentAttemptError() {
  return null;
}
async function sendToContentScript() {
  return {};
}
async function addLog(message, level) {
  logs.push({ message, level });
}
async function setState(payload) {
  stateUpdates.push(payload);
}
async function getState() {
  return { mailProvider: '2925' };
}
const chrome = {
  tabs: {
    async update(tabId, payload) {
      updates.push({ tabId, payload });
    },
  },
};

${bundle}

return {
  requestVerificationCodeResend,
  snapshot() {
    return { updates, logs, stateUpdates };
  },
};
`)();

  await api.requestVerificationCodeResend(7);
  const state = api.snapshot();

  assert.deepStrictEqual(
    state.updates,
    [
      { tabId: 11, payload: { active: true } },
      { tabId: 22, payload: { active: true } },
    ],
    '2925 重发验证码后应先在认证页触发重发，再切回 2925 邮箱标签页等待新邮件'
  );
  assert.strictEqual(
    state.logs.some((entry) => /切换到 2925 邮箱标签页等待新邮件/.test(entry.message)),
    true,
    '应记录切回 2925 邮箱等待新邮件的日志'
  );
  assert.strictEqual(
    state.stateUpdates.length,
    1,
    '步骤 7 重发验证码后应更新 loginVerificationRequestedAt'
  );
}

async function testRunStep7AttemptUsesAuthor2925PollingStrategy() {
  const bundle = [
    extractFunction('runStep7Attempt'),
  ].join('\n');

  const api = new Function(`
let now = 120000;
const logs = [];
const tabUpdates = [];
const reuseCalls = [];
let resolveArgs = null;
const HOTMAIL_PROVIDER = 'hotmail-api';
const Date = {
  now() {
    return now;
  },
};

function throwIfStopped() {}
function getMailConfig() {
  return {
    source: 'mail-2925',
    url: 'https://2925.com/#/mailList',
    label: '2925 邮箱',
    inject: ['content/utils.js', 'content/mail-2925.js'],
    injectSource: 'mail-2925',
  };
}
async function getTabId(source) {
  if (source === 'signup-page') return 11;
  if (source === 'mail-2925') return 22;
  return null;
}
async function isTabAlive() {
  return true;
}
const chrome = {
  tabs: {
    async update(tabId, payload) {
      tabUpdates.push({ tabId, payload });
    },
  },
};
async function addLog(message, level) {
  logs.push({ message, level });
}
async function sendToContentScript() {
  return {};
}
function getStep7RestartFromStep6Error() {
  return null;
}
function getRestartCurrentAttemptError() {
  return null;
}
async function reuseOrCreateTab(source, url, options) {
  reuseCalls.push({ source, url, options });
  return 22;
}
async function resolveVerificationStep(step, state, mail, options) {
  resolveArgs = { step, state, mail, options };
}

${bundle}

return {
  runStep7Attempt,
  snapshot() {
    return { logs, tabUpdates, reuseCalls, resolveArgs };
  },
};
`)();

  await api.runStep7Attempt({
    mailProvider: '2925',
    oauthUrl: 'https://example.com/oauth',
  });
  const state = api.snapshot();

  assert.strictEqual(state.resolveArgs.step, 7, '步骤 7 应继续走原有登录验证码提交流程');
  assert.strictEqual(
    state.resolveArgs.options.filterAfterTimestamp,
    60000,
    '2925 登录验证码轮询应按作者原版放宽 60 秒时间窗'
  );
  assert.strictEqual(
    state.resolveArgs.options.requestFreshCodeFirst,
    false,
    '2925 登录验证码轮询不应一上来先重发验证码'
  );
}

(async () => {
  await testPollFreshVerificationCodeRethrowsStop();
  await testResolveVerificationStepRethrowsStopFromFreshRequest();
  await testResolveVerificationStepRetriesConfiguredPollRoundsBeforeSuccess();
  await testResolveVerificationStepFailsAfterConfiguredPollRoundsForLoginCode();
  await testResolveVerificationStepKeepsSinglePollWhenRetryDisabled();
  await testWaitForVerificationSubmitOutcomeReturnsRestartCurrentAttempt();
  await testWaitForSignupEmailInputOrLaterStateRecognizesAdvancedVerificationPage();
  await testWaitForSignupPasswordInputOrLaterStateRecognizesAdvancedVerificationPage();
  await testExecuteStepA3ReusesExistingSignupEmail();
  await testIsPostSignupSuccessPageAcceptsChatGptLandingWhenWindowStateAffectsVisibility();
  await testIsPostSignupSuccessPageFallsBackToChatGptUrlOnly();
  await testMail2925SeenMailKeyIncludesMailContentBeyondItemId();
  await testMail2925TimeWindowAllowsUnparseableFreshMailInA4Recovery();
  await testMail2925PreviewCodeWithoutExplicitTargetEmailStillAccepted();
  await testMail2925FallsBackToMailBodyWhenPreviewHasNoCode();
  await testMail2925EnsureInboxListReadyNavigatesBackFromReadMail();
  await testRequestVerificationCodeResendSwitchesToMail2925Tab();
  await testRunStep7AttemptUsesAuthor2925PollingStrategy();
  console.log('verification stop propagation tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

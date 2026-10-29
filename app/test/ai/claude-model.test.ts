/**
 * Claude Adapter 的模型可配置性：不绑定 Anthropic 官方命名。
 * 部署环境的网关可能注册任意模型标识，Eve 只做注入安全校验。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeModelOverride, claudeFlags, buildClaudeArguments, claudeHelpRequirements } from '../../src/ai/claude-invocation.ts';
import { safeAgentEnvironment } from '../../src/ai/agent-transport.ts';

test('未设置 EVE_CLAUDE_MODEL 时不传 --model，交由 CLI 自身决定', () => {
  assert.equal(claudeModelOverride({}), null);
  assert.equal(claudeModelOverride({ EVE_CLAUDE_MODEL: '   ' }), null);
  const args = buildClaudeArguments({});
  assert.equal(args.includes('--model'), false);
});

test('接受非 Anthropic 命名的模型标识', () => {
  const model = 'workbuddy-ai/deepseek-v4.1-flash';
  assert.equal(claudeModelOverride({ EVE_CLAUDE_MODEL: model }), model);
  const args = buildClaudeArguments({ EVE_CLAUDE_MODEL: model });
  const at = args.indexOf('--model');
  assert.ok(at >= 0, '必须传入 --model');
  assert.equal(args[at + 1], model, '模型名原样传递，不改写、不加前缀');
});

test('模型名只做注入安全校验，不做命名白名单', () => {
  // 各种非官方命名都应被接受
  for (const name of ['claude-sonnet-4-5', 'qoder-cn/dfmodel', 'auto/gpt-6.1-sol', 'my-local-model:latest']) {
    assert.equal(claudeModelOverride({ EVE_CLAUDE_MODEL: name }), name, name + ' 应被接受');
  }
  // 只拒绝会破坏 argv 或超长的值
  assert.throws(() => claudeModelOverride({ EVE_CLAUDE_MODEL: 'a b' }), /invalid_claude_model/);
  assert.throws(() => claudeModelOverride({ EVE_CLAUDE_MODEL: 'a\nb' }), /invalid_claude_model/);
  assert.throws(() => claudeModelOverride({ EVE_CLAUDE_MODEL: 'a\u0000b' }), /invalid_claude_model/);
  assert.throws(() => claudeModelOverride({ EVE_CLAUDE_MODEL: 'x'.repeat(201) }), /invalid_claude_model/);
});

test('设置模型后预检参数同步变化（单一来源）', () => {
  const without = claudeHelpRequirements({});
  assert.equal(without.includes('--model'), false);
  const withModel = claudeHelpRequirements({ EVE_CLAUDE_MODEL: 'qoder-cn/dfmodel' });
  assert.equal(withModel.includes('--model'), true, '预检必须核对真实调用用到的 --model');
  // 其余参数不受影响
  assert.ok(withModel.includes('--safe-mode'));
  assert.ok(withModel.includes('--print'), '-p 必须映射为 --print 供 help 核对');
});

test('预检清单与真实参数完全一致（无隐藏例外）', () => {
  const required = claudeHelpRequirements({});
  const args = buildClaudeArguments({});
  // --max-turns 已移除（会截断结构化输出），因此不应出现在任一处
  assert.equal(args.includes('--max-turns'), false);
  assert.equal(required.includes('--max-turns'), false);
  // StructuredOutput 必须在真实参数里，且其 flag 可在 help 核对
  assert.equal(args[args.indexOf('--tools') + 1], 'StructuredOutput');
  assert.ok(required.includes('--tools'));
});

test('子进程环境透传模型路由变量，但不过度放开', () => {
  const saved = { ...process.env };
  try {
    process.env['ANTHROPIC_MODEL'] = 'proxy/model-a';
    process.env['ANTHROPIC_DEFAULT_SONNET_MODEL'] = 'proxy/model-b';
    process.env['CLAUDE_CODE_MODEL_CAPABILITIES'] = 'proxy/model-a=effort';
    process.env['EVE_UNRELATED_SECRET'] = 'must-not-leak';
    const env = safeAgentEnvironment();
    assert.equal(env['ANTHROPIC_MODEL'], 'proxy/model-a');
    assert.equal(env['ANTHROPIC_DEFAULT_SONNET_MODEL'], 'proxy/model-b');
    assert.equal(env['CLAUDE_CODE_MODEL_CAPABILITIES'], 'proxy/model-a=effort');
    assert.equal(env['EVE_UNRELATED_SECRET'], undefined, '非白名单变量不得透传');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('claudeFlags 返回值不含空模型', () => {
  const flags = claudeFlags({ EVE_CLAUDE_MODEL: '  ' });
  assert.equal(flags.some(f => f.flag === '--model'), false);
});
